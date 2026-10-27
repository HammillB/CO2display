// K30 CO2 sensor (I2C) -> Particle Cloud.  Version 2.1: stuck-sensor protection, with the reason for each failure in the k30err event.
//
// Wiring: K30 SDA -> D0, SCL -> D1, K30 G0 -> Photon GND (common ground).
// Power the K30 G+ from its own regulated 5 V supply, NOT from the Photon's 3V3.
//
// What changed from version 1: version 1 kept re-publishing the last good number when the
// sensor stopped answering, so a dead sensor looked like a steady reading. This version only
// publishes a number that was just read, and it tries to recover when reads fail or freeze.

#include "Particle.h"

SYSTEM_THREAD(ENABLED);   // keep reading the sensor even if Wi-Fi drops

const uint8_t K30_ADDR = 0x68;

const unsigned long READ_INTERVAL_MS    = 2000;    // read the sensor
const unsigned long PUBLISH_INTERVAL_MS = 60000;   // publish to the cloud

// Recovery ladder. All times are measured from the last GOOD reading.
const unsigned long BUS_RESET_AFTER_MS       = 10000;   // reset the I2C bus
const unsigned long STOP_PUBLISH_AFTER_MS    = 30000;   // stop sending numbers (page turns gray after 5 min)
const unsigned long K30_POWER_CYCLE_AFTER_MS = 90000;   // only if K30_POWER_PIN is wired
const unsigned long REBOOT_AFTER_MS          = 180000;  // reboot the Photon

// A "good" reading that is exactly the same this many reads in a row (150 x 2 s = 5 min)
// is treated as a frozen sensor. Real readings wobble by a few ppm.
const unsigned SAME_VALUE_LIMIT = 150;

// OPTIONAL: a pin that switches the K30's power through a relay module or MOSFET on the G+ line
// (the Photon pin cannot power the K30 itself). HIGH = K30 on. -1 = not wired.
// Power-cycling is the only thing that clears a K30 that has locked up its own I2C interface.
const int K30_POWER_PIN = -1;   // e.g. D2

int co2ppm = -1;                // cloud variable: last good reading
int co2age = 0;                 // cloud variable: seconds since the last good reading
String status = "starting";     // cloud variable: "ok", "no reply", "stuck", or a recovery step

unsigned long lastRead = 0;
unsigned long lastPublish = 0;
unsigned long lastGoodMs = 0;
int lastValue = -1;
unsigned sameCount = 0;
String problem = "no reply";
String failWhy = "";            // why the most recent read attempt failed (goes into the k30err event)
bool busResetDone = false;
bool powerCycleDone = false;
bool bootReported = false;

ApplicationWatchdog *wd;
void watchdogHandler() { System.reset(); }   // if loop() ever hangs for 60 s, reboot

int readCO2() {
  for (int attempt = 0; attempt < 2; attempt++) {
    byte cmd[4] = {0x22, 0x00, 0x08, 0x2A};
    Wire.beginTransmission(K30_ADDR);
    Wire.write(cmd, 4);
    int err = Wire.endTransmission();
    if (err != 0) { failWhy = String("write error ") + String(err); delay(50); continue; }

    delay(20);
    int got = Wire.requestFrom(K30_ADDR, (uint8_t)4);
    if (got != 4) { failWhy = String("short read, got ") + String(got); delay(50); continue; }

    byte r[4];
    for (int i = 0; i < 4; i++) r[i] = Wire.read();

    byte sum = r[0] + r[1] + r[2];
    if ((r[0] & 0x01) && sum == r[3]) {
      return (r[1] << 8) | r[2];
    }
    if (!(r[0] & 0x01)) failWhy = String("not ready, status ") + String((int)r[0]);
    else failWhy = "bad checksum";
    delay(50);
  }
  return -1;
}

// Tell the serial monitor and the Particle console what recovery step is happening.
// The event name must NOT start with "co2": the webhook matches event names by prefix.
void report(const String &what) {
  status = what;
  Serial.printlnf("Recovery: %s", what.c_str());
  if (Particle.connected()) Particle.publish("k30err", what, PRIVATE);
}

void takeReading(unsigned long now) {
  int ppm = readCO2();
  if (ppm <= 0) {
    problem = String("no reply (") + failWhy + ")";
    if (status == "ok") status = problem;
    Serial.println("Failed to read from CO2 sensor");
    return;
  }

  if (ppm == lastValue) { sameCount++; } else { sameCount = 0; lastValue = ppm; }
  co2ppm = ppm;
  Serial.printlnf("CO2 Concentration: %d ppm", ppm);

  if (sameCount >= SAME_VALUE_LIMIT) {
    // The sensor answers, but the number has not moved. Do not count this as a good reading.
    problem = "stuck";
    if (status == "ok") status = problem;
    return;
  }

  // Good reading: clear any recovery state.
  lastGoodMs = now;
  busResetDone = false;
  powerCycleDone = false;
  status = "ok";
}

void powerCycleK30() {
  if (K30_POWER_PIN < 0) return;
  digitalWrite(K30_POWER_PIN, LOW);
  delay(3000);
  digitalWrite(K30_POWER_PIN, HIGH);
  delay(5000);   // let the K30 warm up
}

void recover(unsigned long now) {
  unsigned long bad = now - lastGoodMs;
  if (bad < BUS_RESET_AFTER_MS) return;

  if (!busResetDone) {
    busResetDone = true;
    report(String("bus reset after ") + problem);
    Wire.reset();
    Wire.end();
    Wire.begin();
  }
  if (bad >= K30_POWER_CYCLE_AFTER_MS && !powerCycleDone) {
    powerCycleDone = true;
    if (K30_POWER_PIN >= 0) {
      report("power-cycling the K30");
      powerCycleK30();
    }
  }
  if (bad >= REBOOT_AFTER_MS) {
    report("rebooting the Photon");
    delay(2000);   // give the message time to go out
    System.reset();
  }
}

void setup() {
  Serial.begin(9600);
  Wire.begin();
  if (K30_POWER_PIN >= 0) {
    pinMode(K30_POWER_PIN, OUTPUT);
    digitalWrite(K30_POWER_PIN, HIGH);
  }
  Particle.variable("co2", co2ppm);
  Particle.variable("co2age", co2age);
  Particle.variable("status", status);
  lastGoodMs = millis();          // grace period at boot
  wd = new ApplicationWatchdog(60000, watchdogHandler, 1536);
}

void loop() {
  unsigned long now = millis();

  // Once per boot, say why we restarted. Useful for spotting power problems.
  if (!bootReported && Particle.connected()) {
    Particle.publish("k30info", String("boot, reset reason ") + String((int)System.resetReason()), PRIVATE);
    bootReported = true;
  }

  if (now - lastRead >= READ_INTERVAL_MS) {
    lastRead = now;
    takeReading(now);
  }

  co2age = (int)((now - lastGoodMs) / 1000);
  recover(now);

  // Only publish a number that was read recently.
  bool fresh = (co2ppm > 0) && (now - lastGoodMs < STOP_PUBLISH_AFTER_MS);
  if (fresh && Particle.connected() && (lastPublish == 0 || now - lastPublish >= PUBLISH_INTERVAL_MS)) {
    Particle.publish("co2", String(co2ppm), PRIVATE);
    lastPublish = now;
  }
}
