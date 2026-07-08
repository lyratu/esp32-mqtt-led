#include <WiFi.h>
#include <PubSubClient.h>

#define LED_PIN             6
#define BLINK_MS            200
#define BROADCAST_BLINK_MS  3000

const char* ssid     = "Danke";        // 改成你的 2.4GHz 热点名称
const char* password = "wifi.danke.life";
const char* mqtt_server = "192.168.199.145";  // 改成运行 MQTT 服务器的电脑 IP
const char* topic    = "device/broadcast";

WiFiClient espClient;
PubSubClient client(espClient);

unsigned long blinkUntil = 0;

void mqtt_callback(char* topic, byte* payload, unsigned int length)
{
    blinkUntil = millis() + BROADCAST_BLINK_MS;
}

void mqtt_reconnect(void)
{
    while (!client.connected()) {
        if (client.connect("esp32c3_client")) {
            client.subscribe(topic);
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

    // 收到 MQTT 广播后闪烁一段时间
    if (millis() < blinkUntil) {
        digitalWrite(LED_PIN, HIGH);
        delay(BLINK_MS);
        digitalWrite(LED_PIN, LOW);
        delay(BLINK_MS);
    } else {
        digitalWrite(LED_PIN, HIGH);  // WiFi 和 MQTT 都已连接时常亮
    }
}
