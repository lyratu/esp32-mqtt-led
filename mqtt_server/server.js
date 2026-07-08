const aedes = require('aedes')();
const net = require('net');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const MQTT_PORT = 1883;
const WS_PORT = 8080;
const TOPIC = 'device/broadcast';
const ONLINE_TOPIC = 'device/online';

const tcpServer = net.createServer(aedes.handle);
tcpServer.listen(MQTT_PORT, () => {
    console.log(`MQTT broker listening on tcp://0.0.0.0:${MQTT_PORT}`);
});

const httpServer = http.createServer((req, res) => {
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

// 跟踪在线设备并广播列表
const onlineDevices = new Map();

function publishOnlineList() {
    const list = Array.from(onlineDevices.values()).map(d => ({
        id: d.id,
        connectedAt: d.connectedAt
    }));
    const payload = Buffer.from(JSON.stringify(list));
    aedes.publish({ topic: ONLINE_TOPIC, payload, qos: 0, retain: false }, (err) => {
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

httpServer.listen(WS_PORT, () => {
    console.log(`WebSocket/H5 client server listening on http://0.0.0.0:${WS_PORT}`);
    console.log(`Publish/Subscribe topic: ${TOPIC}`);
});
