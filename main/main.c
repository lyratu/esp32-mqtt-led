#include <WiFi.h>
#include <PubSubClient.h>
#include <string.h>

#define LED_PIN             6
#define BLINK_MS            200
#define BROADCAST_BLINK_MS  3000

const char* ssid     = "Danke";        // 改成你的 2.4GHz 热点名称
const char* password = "wifi.danke.life";
const char* mqtt_server = "192.168.199.145";  // 改成运行 MQTT 服务器的电脑 IP
const char* topic    = "device/broadcast";
const char* cli_topic = "device/cli";

WiFiClient espClient;
PubSubClient client(espClient);

// cliBlinking is a persistent state: once the active CLI reports "running",
// the LED keeps blinking until the server sends "solid" (completed/idle).
bool cliBlinking = false;
unsigned long broadcastBlinkUntil = 0;

void mqtt_callback(char* topic, byte* payload, unsigned int length)
{
    // Make a null-terminated copy so strstr is safe.
    char buf[128];
    unsigned int copyLen = length < sizeof(buf) - 1 ? length : sizeof(buf) - 1;
    memcpy(buf, payload, copyLen);
    buf[copyLen] = '\0';

    if (strcmp(topic, cli_topic) == 0) {
        if (strstr(buf, "\"blink\"") != NULL) {
            // Active CLI is running: blink continuously.
            cliBlinking = true;
        } else if (strstr(buf, "\"solid\"") != NULL) {
            // Active CLI completed or is idle: stop blinking and stay solid.
            cliBlinking = false;
        }
    } else {
        // Broadcast messages still blink for a fixed duration.
        broadcastBlinkUntil = millis() + BROADCAST_BLINK_MS;
    }
}

void mqtt_reconnect(void)
{
    while (!client.connected()) {
        if (client.connect("esp32c3_client")) {
            client.subscribe(topic);
            client.subscribe(cli_topic);
        } else {
            delay(5000);
        }
    }
}

void setup(void)
{
    pinMode(LED_PIN, OUTPUT);
    digitalWrite(LED_PIN, LOW);

    WiFi.begin(ssid, password);

    client.setServer(mqtt_server, 1883);
    client.setCallback(mqtt_callback);
}

void loop(void)
{
    // WiFi 未连接时 LED 闪烁
    while (WiFi.status() != WL_CONNECTED) {
        digitalWrite(LED_PIN, HIGH);
        delay(BLINK_MS);
        digitalWrite(LED_PIN, LOW);
        delay(BLINK_MS);
    }

    // 保持 MQTT 连接
    if (!client.connected()) {
        mqtt_reconnect();
    }
    client.loop();

    // Decide whether to blink:
    // 1. Active CLI is running -> continuous blinking.
    // 2. Broadcast received -> blink for a fixed duration.
    // 3. Otherwise -> solid on.
    bool shouldBlink = cliBlinking || (millis() < broadcastBlinkUntil);

    if (shouldBlink) {
        digitalWrite(LED_PIN, HIGH);
        delay(BLINK_MS);
        digitalWrite(LED_PIN, LOW);
        delay(BLINK_MS);
    } else {
        digitalWrite(LED_PIN, HIGH);  // WiFi 和 MQTT 都已连接时常亮
    }
}
