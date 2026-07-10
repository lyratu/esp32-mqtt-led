const aedes = require('aedes')();
const net = require('net');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { exec } = require('child_process');

const MQTT_PORT = 1883;
const WS_PORT = 8080;
const TOPIC = 'device/broadcast';
const ONLINE_TOPIC = 'device/online';
const CLI_TOPIC = 'device/cli';
const AGENT_TOPIC = 'device/agent';
const CHECK_INTERVAL_MS = 5000;

// ---------------------------------------------------------------------------
// MQTT broker
// ---------------------------------------------------------------------------
const tcpServer = net.createServer(aedes.handle);
tcpServer.listen(MQTT_PORT, () => {
    console.log(`MQTT broker listening on tcp://0.0.0.0:${MQTT_PORT}`);
});

// ---------------------------------------------------------------------------
// HTTP / WebSocket server
// ---------------------------------------------------------------------------
const httpServer = http.createServer((req, res) => {
    // REST API: list agents (merged from multica agent list + runtime list)
    if (req.url === '/api/agents' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(agentService.list()));
        return;
    }

    // REST API: set active agent (only one can be active)
    if (req.url === '/api/agents/active' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { name } = JSON.parse(body);
                const ok = agentService.setActive(name);
                res.writeHead(ok ? 200 : 400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok, active: agentService.active, list: agentService.list() }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: e.message }));
            }
        });
        return;
    }

    // REST API: unset active agent (turn off monitoring)
    if (req.url === '/api/agents/active' && req.method === 'DELETE') {
        agentService.setActive(null);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, active: null, list: agentService.list() }));
        return;
    }

    // Static files
    let filePath = path.join(__dirname, 'public', req.url === '/' ? 'index.html' : req.url);
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css'
    };

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404);
            res.end('Not found');
            return;
        }
        res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
        res.end(data);
    });
});

const wss = new WebSocket.Server({ server: httpServer });
wss.on('connection', (ws) => {
    const stream = WebSocket.createWebSocketStream(ws);
    aedes.handle(stream);
});

httpServer.listen(WS_PORT, () => {
    console.log(`WebSocket/H5 client server listening on http://0.0.0.0:${WS_PORT}`);
    console.log(`Publish/Subscribe topic: ${TOPIC}`);
    console.log(`Agent command topic: ${CLI_TOPIC}`);
});

// ---------------------------------------------------------------------------
// Online device tracking
// ---------------------------------------------------------------------------
const onlineDevices = new Map();

function publishOnlineList() {
    const list = Array.from(onlineDevices.values()).map(d => ({
        id: d.id,
        connectedAt: d.connectedAt
    }));
    const payload = Buffer.from(JSON.stringify(list));
    aedes.publish({ topic: ONLINE_TOPIC, payload, qos: 0, retain: true }, (err) => {
        if (err) console.error('广播在线设备列表失败:', err.message);
    });
}

aedes.on('client', (client) => {
    if (!client || !client.id) return;
    onlineDevices.set(client.id, { id: client.id, connectedAt: Date.now() });
    publishOnlineList();
});

aedes.on('clientDisconnect', (client) => {
    if (!client || !client.id) return;
    onlineDevices.delete(client.id);
    publishOnlineList();
});

// ---------------------------------------------------------------------------
// Agent monitoring via multica CLI
// ---------------------------------------------------------------------------
const agentService = {
    // name -> { status, provider, runtimeId, version, runtimeStatus, updatedAt }
    agents: new Map(),
    active: null,

    list() {
        return Array.from(this.agents.entries()).map(([name, state]) => ({
            name,
            active: this.active === name,
            ...state
        }));
    },

    setActive(name) {
        if (name && !this.agents.has(name)) return false;
        this.active = name || null;
        publishAgentState();
        evaluateCLICommand();
        return true;
    },

    update(name, patch) {
        const state = this.agents.get(name);
        if (!state) return;
        Object.assign(state, patch, { updatedAt: Date.now() });
    }
};

let previousActiveWorking = false;

function evaluateCLICommand() {
    const activeName = agentService.active;
    const activeState = activeName ? agentService.agents.get(activeName) : null;
    const activeWorking = activeState ? activeState.status === 'working' : false;

    if (activeWorking && !previousActiveWorking) {
        publishCLICommand('blink');
        console.log(`Active agent ${activeName} 进入 working -> 发送 blink`);
    } else if (!activeWorking && previousActiveWorking) {
        publishCLICommand('solid');
        console.log(`Active agent ${activeName} 完成/idle -> 发送 solid`);
    }
    previousActiveWorking = activeWorking;
}

function publishCLICommand(command) {
    const payload = Buffer.from(JSON.stringify({ command }));
    aedes.publish({ topic: CLI_TOPIC, payload, qos: 0, retain: false }, (err) => {
        if (err) console.error(`发送 CLI 命令 ${command} 失败:`, err.message);
    });
}

function publishAgentState() {
    const list = agentService.list();
    const payload = Buffer.from(JSON.stringify(list));
    aedes.publish({ topic: AGENT_TOPIC, payload, qos: 0, retain: true }, (err) => {
        if (err) console.error('广播 Agent 列表失败:', err.message);
    });
}

// Run `multica agent list --output json` and `multica runtime list --output json`,
// then merge the data.
function pollMultica() {
    exec('multica agent list --output json 2>/dev/null', { timeout: 10000 }, (err, stdout) => {
        let agents = [];
        if (!err && stdout) {
            try { agents = JSON.parse(stdout); } catch (e) {
                console.error('解析 agent list JSON 失败:', e.message);
            }
        }

        exec('multica runtime list --output json 2>/dev/null', { timeout: 10000 }, (rtErr, rtStdout) => {
            let runtimes = [];
            if (!rtErr && rtStdout) {
                try { runtimes = JSON.parse(rtStdout); } catch (e) {
                    console.error('解析 runtime list JSON 失败:', e.message);
                }
            }

            // Build a runtime lookup by runtime_id
            const runtimeById = new Map();
            runtimes.forEach(rt => runtimeById.set(rt.id, rt));

            // Build a runtime lookup by provider (for agents without runtime_id)
            const runtimeByProvider = new Map();
            runtimes.forEach(rt => runtimeByProvider.set(rt.provider, rt));

            const previousNames = new Set(agentService.agents.keys());
            const currentNames = new Set();

            agents.forEach(agent => {
                if (agent.archived_at) return; // skip archived

                const name = agent.name;
                currentNames.add(name);

                // Find the associated runtime
                const runtime = agent.runtime_id
                    ? runtimeById.get(agent.runtime_id)
                    : runtimeByProvider.get(agent.runtime_mode === 'local' ? 'claude' : null);

                const state = {
                    status: agent.status || 'idle',       // idle / working
                    agentId: agent.id,
                    provider: runtime ? runtime.provider : (agent.runtime_mode || ''),
                    runtimeStatus: runtime ? runtime.status : 'unknown', // online / offline
                    version: runtime ? (runtime.metadata && runtime.metadata.version || '') : '',
                    runtimeId: runtime ? runtime.id : (agent.runtime_id || ''),
                    lastSeen: Date.now()
                };

                if (agentService.agents.has(name)) {
                    const before = agentService.agents.get(name).status;
                    agentService.update(name, state);
                    const after = agentService.agents.get(name).status;
                    if (before !== after) {
                        console.log(`Agent ${name}: ${before} -> ${after}`);
                    }
                } else {
                    agentService.agents.set(name, { ...state, updatedAt: Date.now() });
                    console.log(`发现 agent: ${name} (${state.status})`);
                }
            });

            // Remove agents that disappeared (e.g. archived or deleted)
            previousNames.forEach(name => {
                if (!currentNames.has(name)) {
                    agentService.agents.delete(name);
                    if (agentService.active === name) {
                        const remaining = Array.from(agentService.agents.keys());
                        agentService.active = remaining.length > 0 ? remaining[0] : null;
                    }
                    console.log(`移除 agent: ${name}`);
                }
            });

            // If no active is set yet, default to first
            if (agentService.active === null && agentService.agents.size > 0) {
                agentService.active = Array.from(agentService.agents.keys())[0];
            }

            publishAgentState();
            evaluateCLICommand();
        });
    });
}

setInterval(pollMultica, CHECK_INTERVAL_MS);
pollMultica(); // initial poll
