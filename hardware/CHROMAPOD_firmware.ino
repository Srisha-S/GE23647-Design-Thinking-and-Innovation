#include <Wire.h>
#include <SPI.h>
#include <math.h>
#include <string.h>

#include <Adafruit_GFX.h>
#include <Adafruit_ST7735.h>
#include "Adafruit_TCS34725.h"

#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

// =====================================================
// CHROMAPOD V14 EXPERIMENTAL CALIBRATION + FULL TFT RESULT UI
// =====================================================
//
// HARDWARE:
//
// ESP32-WROOM-32
// TCS34725
// ST7735 1.8" 128x160
// KY-040 Rotary Encoder
// Separate tactile SCAN button
//
// -----------------------------------------------------
//
// MAIN HARDWARE FUNCTIONS:
//
// 1. SCAN
// 2. COMPARE
// 3. IMAGE MATCH
//
// -----------------------------------------------------
//
// ROTARY:
//
// TURN  = Navigate / change format / choose YES-CANCEL
// PRESS = Open / Back / Confirm
//
// TACTILE BUTTON:
//
// Scan / Rescan / Proceed
//
// -----------------------------------------------------
//
// BLE PACKETS:
//
// SCAN,R,G,B,CLEAR
// REF,R,G,B
// CMP,R,G,B,DELTA_E
//
// Image Match uses normal SCAN packet.
// Optional app-to-POD result: IMR,R,G,B,DELTA_E
// Sent to COMMAND characteristic after app computes match.
//
// =====================================================


// =====================================================
// TFT
// =====================================================

#define TFT_CS   27
#define TFT_DC   26
#define TFT_RST  25

Adafruit_ST7735 tft(
  TFT_CS,
  TFT_DC,
  TFT_RST
);


// =====================================================
// CONTROLS
// =====================================================

#define SCAN_BUTTON 32

#define ENC_CLK 33
#define ENC_DT  14
#define ENC_SW  13


// =====================================================
// TCS34725
// =====================================================

Adafruit_TCS34725 tcs(
  TCS34725_INTEGRATIONTIME_50MS,
  TCS34725_GAIN_4X
);


// =====================================================
// BATTERY / CHARGE DISPLAY
// =====================================================
//
// IMPORTANT:
//
// Your current USB / power-bank setup does NOT tell
// the ESP32 how much battery is left.
//
// Keep this at 0 for the current prototype.
//
// Header will display:
//
// USB
//
// -----------------------------------------------------
//
// FUTURE LIPO:
//
// If you add a LiPo + voltage divider:
//
// LiPo + ----100k----+---- GPIO34
//                   |
//                  100k
//                   |
//                  GND
//
// then change:
//
// BATTERY_MONITOR_ENABLED 1
//
// The display will show approximate percentage.
//
// DO NOT connect LiPo directly to GPIO34.
//
// =====================================================

#define BATTERY_MONITOR_ENABLED 0

#define BATTERY_PIN 34

const float BATTERY_DIVIDER_RATIO = 2.0;


// =====================================================
// SERIAL DIAGNOSTICS (LOG ONLY, NO SENSOR/COLOR CHANGES)
// =====================================================
// Set to 0 after recalibration to disable calibration lines.
#define CALIBRATION_SERIAL_LOG 1


// =====================================================
// SELECTABLE COLOUR CALIBRATION PROFILES
// =====================================================
//  9 = original working V9 calibration (exact original constants)
// 10 = measured V10 calibration (established baseline)
// 11 = experimental V11 matrix (modest change, validation required)
// 12 = A4 normal-paper reference test (B/W & neutral only, V10 matrix)
// 13 = current A4 measurement setup: repeatable RGBC white/black
// 14 = experimental 16-swatch recalibration; teal/indigo/brown held out
//
// This only affects RGBC normalization and colour conversion.
// It does not change TFT, buttons, encoder, BLE, or scan modes.
//
// IMPORTANT: The calibration is adjusted toward the DESIGNED HEX
// labels on the printed swatch sheet, not instrument-measured ink.
// It must not be described as certified colour accuracy.
#define CHROMAPOD_CALIBRATION_PROFILE 14

#if CHROMAPOD_CALIBRATION_PROFILE != 9 && \
    CHROMAPOD_CALIBRATION_PROFILE != 10 && \
    CHROMAPOD_CALIBRATION_PROFILE != 11 && \
    CHROMAPOD_CALIBRATION_PROFILE != 12 && \
    CHROMAPOD_CALIBRATION_PROFILE != 13 && \
    CHROMAPOD_CALIBRATION_PROFILE != 14
  #error "CHROMAPOD_CALIBRATION_PROFILE must be 9, 10, 11, 12, 13, or 14"
#endif

// =====================================================
// CALIBRATION
// =====================================================
#if CHROMAPOD_CALIBRATION_PROFILE == 9

// Working V9 reference constants.
const float BLACK_R = 67.0;
const float BLACK_G = 46.0;
const float BLACK_B = 26.0;
const float BLACK_C = 139.0;

const float WHITE_R = 759.0;
const float WHITE_G = 588.3;
const float WHITE_B = 350.2;
const float WHITE_C = 1720.0;

const float M_RR = 1.886708;
const float M_RG = -0.814308;
const float M_RB = -0.156470;
const float M_GR = -0.335470;
const float M_GG = 1.747816;
const float M_GB = -0.470332;
const float M_BR = -0.598741;
const float M_BG = -0.829314;
const float M_BB = 2.281744;

const float NEUTRAL_EXPONENT = 0.544;

#elif CHROMAPOD_CALIBRATION_PROFILE == 10

// Calibrated V10: measured matte black/white and initial swatches.
const float BLACK_R = 57.96;
const float BLACK_G = 38.36;
const float BLACK_B = 23.92;
const float BLACK_C = 117.92;

const float WHITE_R = 757.80;
const float WHITE_G = 584.80;
const float WHITE_B = 338.67;
const float WHITE_C = 1699.71;

const float M_RR = 1.63604772;
const float M_RG = -0.70209369;
const float M_RB = 0.05065869;
const float M_GR = -0.24602587;
const float M_GG = 1.70752258;
const float M_GB = -0.17173280;
const float M_BR = -0.60348489;
const float M_BG = -1.07452231;
const float M_BB = 2.69555196;

const float NEUTRAL_EXPONENT = 0.450;

#elif CHROMAPOD_CALIBRATION_PROFILE == 11

// Experimental V11: same measured black/white and neutral exponent
// as V10; conservative ridge-regularized matrix adjustment.
// Matrix fitted on 12 chromatic reference swatches recorded BEFORE
// Coral, Olive, Lavender and Sand. Those four were held out for
// an offline check (not a physical V11 measurement).
// Mean target-HEX deltaE00 for those four: V10 5.83; predicted V11 5.07.
// Overall 18-swatch offline mean: V10 5.59; predicted V11 5.42.
// Gains are small and mixed across colours: do not assume V11 wins.
const float BLACK_R = 57.96;
const float BLACK_G = 38.36;
const float BLACK_B = 23.92;
const float BLACK_C = 117.92;

const float WHITE_R = 757.80;
const float WHITE_G = 584.80;
const float WHITE_B = 338.67;
const float WHITE_C = 1699.71;

const float M_RR = 1.69065496;
const float M_RG = -0.68513298;
const float M_RB = 0.04666414;
const float M_GR = -0.27687602;
const float M_GG = 1.65291950;
const float M_GB = -0.11441977;
const float M_BR = -0.60990610;
const float M_BG = -1.07776177;
const float M_BB = 2.70944855;

const float NEUTRAL_EXPONENT = 0.450;

#elif CHROMAPOD_CALIBRATION_PROFILE == 12

// EXPERIMENTAL A4 NORMAL-PAPER REFERENCE — 5 black and 5 white scans.
// Same TCS34725 50ms / 4x / five-sample averaging as previous profiles.
// Black avg RGBC: 71.32, 49.56, 28.40, 149.72.
// White avg RGBC: 840.48, 654.32, 386.12, 1903.24.
// V10 colour matrix is deliberately retained; this tests whether
// substrate-specific normalization improves results before refitting.
// The neutral exponent 0.544 maps the measured A4 mid-grey Clear
// average ~643.5 to approximately RGB(128,128,128).
// The chart's printed RGB labels are not instrument-measured colours.
const float BLACK_R = 71.32;
const float BLACK_G = 49.56;
const float BLACK_B = 28.40;
const float BLACK_C = 149.72;

const float WHITE_R = 840.48;
const float WHITE_G = 654.32;
const float WHITE_B = 386.12;
const float WHITE_C = 1903.24;

const float M_RR = 1.63604772;
const float M_RG = -0.70209369;
const float M_RB = 0.05065869;
const float M_GR = -0.24602587;
const float M_GG = 1.70752258;
const float M_GB = -0.17173280;
const float M_BR = -0.60348489;
const float M_BG = -1.07452231;
const float M_BB = 2.69555196;

const float NEUTRAL_EXPONENT = 0.544;

#elif CHROMAPOD_CALIBRATION_PROFILE == 13

// EXPERIMENTAL A4 CURRENT-CONTACT TEST — 3 white and 2 black scans.
// White RGBC mean: 715.067, 557.133, 328.600, 1617.867.
// Black RGBC mean: 71.100, 49.800, 28.700, 150.100.
// Existing V10 matrix is RETAINED; neutral exponent unchanged from V12.
// Reverting to a brighter measurement setup may clip highlights; test before use.
const float BLACK_R = 71.10;
const float BLACK_G = 49.80;
const float BLACK_B = 28.70;
const float BLACK_C = 150.10;

const float WHITE_R = 715.067;
const float WHITE_G = 557.133;
const float WHITE_B = 328.600;
const float WHITE_C = 1617.867;

const float M_RR = 1.63604772;
const float M_RG = -0.70209369;
const float M_RB = 0.05065869;
const float M_GR = -0.24602587;
const float M_GG = 1.70752258;
const float M_GB = -0.17173280;
const float M_BR = -0.60348489;
const float M_BG = -1.07452231;
const float M_BB = 2.69555196;

const float NEUTRAL_EXPONENT = 0.544;

#elif CHROMAPOD_CALIBRATION_PROFILE == 14

// V14 EXPERIMENTAL: refit against the user's 2026 A4 16-colour sheet.
// Five physical scans per colour. Black/white endpoint RGBC are means
// of the five measured patches, not certified colour references.
// Chromatic matrix fitted with ridge regularization (lambda=0.02),
// using 9 chromatic printed-code targets: red, orange, yellow, lime,
// green, cyan, blue, purple, pink. Teal, indigo, brown were excluded
// from fitting for an offline holdout prediction. New firmware has NOT
// been physically validated. Recheck all colours before adoption.
// Underlying colours on paper may differ from labelled digital RGB.
const float BLACK_R = 80.48f;
const float BLACK_G = 55.96f;
const float BLACK_B = 32.04f;
const float BLACK_C = 169.00f;

const float WHITE_R = 787.12f;
const float WHITE_G = 610.36f;
const float WHITE_B = 359.68f;
const float WHITE_C = 1777.16f;

const float M_RR = 1.5594f;
const float M_RG = -0.6048f;
const float M_RB = -0.1329f;
const float M_GR = -0.3382f;
const float M_GG = 1.5564f;
const float M_GB = -0.3656f;
const float M_BR = -0.4234f;
const float M_BG = -0.8239f;
const float M_BB = 1.9876f;

// Used only by legacy profiles; V14 neutral correction uses measured
// piecewise grey anchors (black, mid-grey, light grey, white).
const float NEUTRAL_EXPONENT = 0.544f;

#endif


// =====================================================
// BLE UUIDs
// =====================================================

#define CHROMA_SERVICE_UUID \
  "9f1c0001-5a7e-4c4d-b2a1-8f4d1c2e3a40"

#define CHROMA_DATA_UUID \
  "9f1c0002-5a7e-4c4d-b2a1-8f4d1c2e3a40"

#define CHROMA_COMMAND_UUID \
  "9f1c0003-5a7e-4c4d-b2a1-8f4d1c2e3a40"


BLEServer* chromaServer = nullptr;

BLECharacteristic* dataCharacteristic = nullptr;
BLECharacteristic* commandCharacteristic = nullptr;

BLEAdvertising* chromaAdvertising = nullptr;


// Physical BLE link exists

volatile bool bleLinkConnected = false;


// User has approved connection on CHROMAPOD

volatile bool bleApproved = false;


// Events from BLE callbacks

volatile bool bleConnectEvent = false;
volatile bool bleDisconnectEvent = false;


// Connection approval dialog

bool connectionPromptVisible = false;

// 0 = YES
// 1 = CANCEL

int connectionChoice = 0;


unsigned long bleApprovedAt = 0;


// =====================================================
// APP MODE
// =====================================================

enum AppMode {

  MODE_HOME,
  MODE_SCAN,
  MODE_COMPARE,
  MODE_IMAGE_MATCH

};


AppMode currentMode = MODE_HOME;


// =====================================================
// HOME MENU
// =====================================================

const char* menuItems[] = {

  "SCAN",
  "COMPARE",
  "IMAGE MATCH"

};


const int MENU_COUNT = 3;

int selectedMenu = 0;


// =====================================================
// SCAN STATE
// =====================================================

bool scanHasResult = false;

int scanR = 0;
int scanG = 0;
int scanB = 0;

uint16_t scanClear = 0;


// 0 HEX
// 1 RGB
// 2 HSL
// 3 CMYK
// 4 LAB

int scanFormat = 0;

const int SCAN_FORMAT_COUNT = 5;


// =====================================================
// COMPARE STATE
// =====================================================
//
// Stage 0 = Reference
// Stage 1 = Sample
// Stage 2 = Proceed to Result
//
// Third press DOES NOT read sensor.
//
// =====================================================

int compareStage = 0;

bool compareResultShowing = false;

float lastDeltaE = 0;

// 0 = split-circle estimate; 1 = HEX swatches; 2 = RGB values.
int compareResultPage = 0;


// Reference

int refR = 0;
int refG = 0;
int refB = 0;

uint16_t refClear = 0;


// Sample

int sampleR = 0;
int sampleG = 0;
int sampleB = 0;

uint16_t sampleClear = 0;


// =====================================================
// IMAGE MATCH STATE
// =====================================================

bool imPhysicalSaved = false;

bool imPendingSend = false;

int imR = 0;
int imG = 0;
int imB = 0;

uint16_t imClear = 0;

// App owns the uploaded image and calculates the image-match dE00.
// The sensor cannot infer the app's target colour from its own scan.
// When the app writes IMR,R,G,B,DELTA_E to CHROMA_COMMAND_UUID,
// CHROMAPOD displays target vs scanned colour and the app-supplied dE.
bool imHasAppResult = false;
int imTargetR = 0;
int imTargetG = 0;
int imTargetB = 0;
float imAppDeltaE = 0.0f;
int imResultPage = 0;

// BLE callback runs on a different FreeRTOS task. Collect the command
// here, then update the TFT only in loop()/processBLEEvents().
portMUX_TYPE imCommandMux = portMUX_INITIALIZER_UNLOCKED;
volatile bool imResultPacketPending = false;
int imPendingR = 0;
int imPendingG = 0;
int imPendingB = 0;
float imPendingDeltaE = 0.0f;


// =====================================================
// ROTARY STATE
// =====================================================

uint8_t encoderState = 0;

int encoderAccumulator = 0;


const int8_t encoderTable[16] = {

   0, -1,  1,  0,

   1,  0,  0, -1,

  -1,  0,  0,  1,

   0,  1, -1,  0

};


// =====================================================
// BASIC MATH
// =====================================================

float clamp01(float x) {

  if (x < 0.0) return 0.0;

  if (x > 1.0) return 1.0;

  return x;
}


float linearToSRGB(float x) {

  x = clamp01(x);

  if (x <= 0.0031308) {

    return 12.92 * x;
  }

  return

    1.055
    *
    pow(
      x,
      1.0 / 2.4
    )
    -
    0.055;
}


// =====================================================
// BUTTON
// =====================================================

bool buttonPressed(int pin) {

  if (digitalRead(pin) == LOW) {

    delay(25);

    if (digitalRead(pin) == LOW) {

      while (digitalRead(pin) == LOW) {

        delay(4);
      }

      delay(30);

      return true;
    }
  }

  return false;
}


// =====================================================
// ROTARY
// =====================================================

int readEncoderStep() {

  uint8_t currentState =

    (
      digitalRead(ENC_CLK)
      <<
      1
    )

    |

    digitalRead(ENC_DT);


  encoderState =

    (
      (encoderState << 2)
      |
      currentState
    )

    &
    0x0F;


  encoderAccumulator +=

    encoderTable[
      encoderState
    ];


  if (encoderAccumulator >= 4) {

    encoderAccumulator = 0;

    return 1;
  }


  if (encoderAccumulator <= -4) {

    encoderAccumulator = 0;

    return -1;
  }


  return 0;
}


// =====================================================
// BATTERY
// =====================================================

#if BATTERY_MONITOR_ENABLED

float readBatteryVoltage() {

  uint32_t totalMv = 0;


  for (int i = 0; i < 8; i++) {

    totalMv +=
      analogReadMilliVolts(
        BATTERY_PIN
      );

    delay(2);
  }


  float pinVoltage =

    (
      totalMv / 8.0
    )
    /
    1000.0;


  return

    pinVoltage
    *
    BATTERY_DIVIDER_RATIO;
}


int batteryPercentFromVoltage(float v) {

  if (v >= 4.20) return 100;
  if (v >= 4.15) return 95;
  if (v >= 4.10) return 90;
  if (v >= 4.05) return 85;
  if (v >= 4.00) return 80;
  if (v >= 3.95) return 75;
  if (v >= 3.90) return 70;
  if (v >= 3.85) return 62;
  if (v >= 3.80) return 55;
  if (v >= 3.75) return 47;
  if (v >= 3.70) return 40;
  if (v >= 3.65) return 32;
  if (v >= 3.60) return 25;
  if (v >= 3.55) return 18;
  if (v >= 3.50) return 12;
  if (v >= 3.40) return 6;
  if (v >= 3.30) return 3;

  return 0;
}


int readBatteryPercent() {

  return

    batteryPercentFromVoltage(
      readBatteryVoltage()
    );
}

#endif


// =====================================================
// TEXT HELPERS
// =====================================================

void centerText(
  const String &text,
  int y,
  int size,
  uint16_t colour = ST77XX_WHITE
) {

  int width =

    text.length()
    *
    6
    *
    size;


  int x =

    (
      160 - width
    )
    /
    2;


  if (x < 1) {

    x = 1;
  }


  tft.setTextSize(size);

  tft.setTextColor(colour);

  tft.setCursor(
    x,
    y
  );

  tft.print(text);
}


// =====================================================
// BATTERY ICON
// =====================================================

#if BATTERY_MONITOR_ENABLED

void drawBatteryIcon(
  int percent
) {

  int x = 137;
  int y = 5;

  int w = 18;
  int h = 9;


  tft.drawRect(
    x,
    y,
    w,
    h,
    ST77XX_WHITE
  );


  tft.fillRect(
    x + w,
    y + 2,
    2,
    h - 4,
    ST77XX_WHITE
  );


  int fill =

    map(
      constrain(
        percent,
        0,
        100
      ),
      0,
      100,
      0,
      w - 4
    );


  uint16_t colour;


  if (percent <= 15) {

    colour = ST77XX_RED;
  }

  else if (percent <= 35) {

    colour = ST77XX_YELLOW;
  }

  else {

    colour = ST77XX_GREEN;
  }


  if (fill > 0) {

    tft.fillRect(
      x + 2,
      y + 2,
      fill,
      h - 4,
      colour
    );
  }
}

#endif


// =====================================================
// HEADER
// =====================================================

void drawHeader() {

  tft.fillRect(
    0,
    0,
    160,
    20,
    ST77XX_BLACK
  );


  // ---------------------------------------------------
  // Product name
  // ---------------------------------------------------

  tft.setTextSize(1);

  tft.setTextColor(
    ST77XX_WHITE
  );

  tft.setCursor(
    4,
    6
  );

  tft.print(
    "CHROMAPOD"
  );


  // ---------------------------------------------------
  // BLE state
  // ---------------------------------------------------

  uint16_t dotColour;


  if (
    bleLinkConnected
    &&
    !bleApproved
  ) {

    dotColour =
      ST77XX_YELLOW;
  }

  else if (
    bleApproved
  ) {

    dotColour =
      ST77XX_GREEN;
  }

  else {

    dotColour =
      ST77XX_RED;
  }


  tft.fillCircle(
    69,
    9,
    3,
    dotColour
  );


  tft.setCursor(
    76,
    6
  );


  if (
    bleLinkConnected
    &&
    !bleApproved
  ) {

    tft.print(
      "ASK"
    );
  }

  else if (
    bleApproved
  ) {

    tft.print(
      "APP"
    );
  }

  else {

    tft.print(
      "OFF"
    );
  }


  // ---------------------------------------------------
  // Battery / USB
  // ---------------------------------------------------

#if BATTERY_MONITOR_ENABLED

  int batteryPercent =
    readBatteryPercent();


  tft.setCursor(
    103,
    6
  );


  tft.print(
    batteryPercent
  );

  tft.print(
    "%"
  );


  drawBatteryIcon(
    batteryPercent
  );

#else

  tft.setCursor(
    128,
    6
  );

  tft.print(
    "USB"
  );

#endif


  // Divider

  tft.drawFastHLine(
    4,
    19,
    152,
    ST77XX_WHITE
  );
}


// =====================================================
// FOOTER
// =====================================================

void drawFooter(
  const char* text
) {

  tft.fillRect(
    0,
    108,
    160,
    20,
    ST77XX_BLACK
  );


  tft.drawFastHLine(
    4,
    108,
    152,
    ST77XX_WHITE
  );


  tft.setTextSize(1);

  tft.setTextColor(
    ST77XX_WHITE
  );


  int width =
    strlen(text)
    *
    6;


  int x =

    (
      160 - width
    )
    /
    2;


  if (x < 1) {

    x = 1;
  }


  tft.setCursor(
    x,
    116
  );


  tft.print(text);
}


// =====================================================
// BOOT
// =====================================================

void drawBootScreen() {

  tft.fillScreen(
    ST77XX_BLACK
  );


  centerText(
    "CHROMAPOD",
    56,
    2,
    ST77XX_WHITE
  );
}


// =====================================================
// HOME
// =====================================================

void drawMenu() {

  tft.fillScreen(
    ST77XX_BLACK
  );


  drawHeader();


  const int yPositions[3] = {

    35,
    60,
    85

  };


  for (
    int i = 0;
    i < MENU_COUNT;
    i++
  ) {

    int y =
      yPositions[i];


    if (
      i == selectedMenu
    ) {

      tft.fillRoundRect(
        13,
        y - 5,
        134,
        19,
        4,
        ST77XX_YELLOW
      );


      tft.setTextColor(
        ST77XX_BLACK
      );


      tft.setTextSize(1);


      tft.setCursor(
        23,
        y + 1
      );


      tft.print(
        "> "
      );


      tft.print(
        menuItems[i]
      );
    }

    else {

      tft.setTextColor(
        ST77XX_WHITE
      );


      tft.setTextSize(1);


      tft.setCursor(
        23,
        y + 1
      );


      tft.print(
        "  "
      );


      tft.print(
        menuItems[i]
      );
    }
  }


  drawFooter(
    "TURN:NAV  PRESS:OPEN"
  );
}


// =====================================================
// CONNECTION APPROVAL POPUP
// =====================================================

void drawConnectionPrompt() {

  tft.fillScreen(
    ST77XX_BLACK
  );


  drawHeader();


  centerText(
    "CONNECT APP?",
    29,
    2
  );


  centerText(
    "CHROMA STUDIO",
    56,
    1
  );


  centerText(
    "WANTS TO CONNECT",
    70,
    1
  );


  // YES

  if (
    connectionChoice == 0
  ) {

    tft.fillRoundRect(
      14,
      84,
      57,
      18,
      4,
      ST77XX_YELLOW
    );


    tft.setTextColor(
      ST77XX_BLACK
    );
  }

  else {

    tft.drawRoundRect(
      14,
      84,
      57,
      18,
      4,
      ST77XX_WHITE
    );


    tft.setTextColor(
      ST77XX_WHITE
    );
  }


  tft.setTextSize(1);


  tft.setCursor(
    32,
    90
  );


  tft.print(
    "YES"
  );


  // CANCEL

  if (
    connectionChoice == 1
  ) {

    tft.fillRoundRect(
      88,
      84,
      58,
      18,
      4,
      ST77XX_YELLOW
    );


    tft.setTextColor(
      ST77XX_BLACK
    );
  }

  else {

    tft.drawRoundRect(
      88,
      84,
      58,
      18,
      4,
      ST77XX_WHITE
    );


    tft.setTextColor(
      ST77XX_WHITE
    );
  }


  tft.setCursor(
    99,
    90
  );


  tft.print(
    "CANCEL"
  );


  drawFooter(
    "TURN:SELECT PRESS:OK"
  );
}


// =====================================================
// BLE ADVERTISING
// =====================================================

void startChromaAdvertising() {

  if (
    chromaAdvertising == nullptr
  ) {

    return;
  }


  if (
    bleLinkConnected
  ) {

    return;
  }


  chromaAdvertising->start();


  Serial.println(
    "BLE ADVERTISING"
  );
}


// =====================================================
// BLE SEND
// =====================================================

bool sendBLE(
  const String &packet
) {

  Serial.print(
    "BLE DATA: "
  );

  Serial.println(
    packet
  );


  if (
    !bleLinkConnected
    ||
    !bleApproved
  ) {

    Serial.println(
      "BLE not approved"
    );


    return false;
  }


  dataCharacteristic->setValue(
    packet.c_str()
  );


  dataCharacteristic->notify();


  return true;
}


// =====================================================
// BLE SERVER CALLBACKS
// =====================================================

class ChromaServerCallbacks :
  public BLEServerCallbacks {

  void onConnect(
    BLEServer* server
  ) {

    bleLinkConnected = true;

    bleApproved = false;

    bleConnectEvent = true;


    Serial.println(
      "BLE LINK REQUEST RECEIVED"
    );
  }


  void onDisconnect(
    BLEServer* server
  ) {

    bleLinkConnected = false;

    bleApproved = false;

    bleDisconnectEvent = true;


    Serial.println(
      "BLE DISCONNECTED"
    );
  }
};


// =====================================================
// COMMAND CALLBACK
// =====================================================

class CommandCallbacks :
  public BLECharacteristicCallbacks {

  void onWrite(
    BLECharacteristic* characteristic
  ) {

    // Ignore commands until user approves device.

    if (
      !bleApproved
    ) {

      return;
    }


    String command =

      characteristic
      ->getValue()
      .c_str();


    command.trim();


    if (
      command.length() == 0
    ) {

      return;
    }


    Serial.print(
      "BLE COMMAND: "
    );

    Serial.println(
      command
    );

    // Optional extension; all original app commands remain supported.
    // The app supplies *its* CIEDE2000 result, not an ESP32 guess.
    // Prefer compact IMR: within legacy 20-byte BLE write payload.
    // Syntax: IMR,183,217,247,4.3
    // Longer IMRESULT form is also accepted for capable clients.
    int r, g, b;
    float delta;
    char extra;
    int fields = sscanf(command.c_str(), "IMR,%d,%d,%d,%f%c",
                        &r, &g, &b, &delta, &extra);
    if (fields != 4) {
      fields = sscanf(command.c_str(), "IMRESULT,%d,%d,%d,%f%c",
                      &r, &g, &b, &delta, &extra);
    }
    if (fields == 4 &&
        r >= 0 && r <= 255 &&
        g >= 0 && g <= 255 &&
        b >= 0 && b <= 255 &&
        isfinite(delta) && delta >= 0.0f && delta <= 1000.0f) {
      portENTER_CRITICAL(&imCommandMux);
      imPendingR = r;
      imPendingG = g;
      imPendingB = b;
      imPendingDeltaE = delta;
      imResultPacketPending = true;
      portEXIT_CRITICAL(&imCommandMux);
      Serial.println("IMAGE MATCH RESULT QUEUED");
    }
  }
};


// =====================================================
// SENSOR READING
// =====================================================

void getColour(
  int &R,
  int &G,
  int &B,
  uint16_t &clearValue
) {

  uint32_t rTotal = 0;
  uint32_t gTotal = 0;
  uint32_t bTotal = 0;
  uint32_t cTotal = 0;


  for (
    int i = 0;
    i < 5;
    i++
  ) {

    uint16_t r;
    uint16_t g;
    uint16_t b;
    uint16_t c;


    tcs.getRawData(
      &r,
      &g,
      &b,
      &c
    );


    rTotal += r;
    gTotal += g;
    bTotal += b;
    cTotal += c;


    delay(30);
  }


  float r =
    rTotal / 5.0;

  float g =
    gTotal / 5.0;

  float b =
    bTotal / 5.0;

  float c =
    cTotal / 5.0;


  clearValue =
    (uint16_t)c;


  float nr =

    (r - BLACK_R)
    /
    (WHITE_R - BLACK_R);


  float ng =

    (g - BLACK_G)
    /
    (WHITE_G - BLACK_G);


  float nb =

    (b - BLACK_B)
    /
    (WHITE_B - BLACK_B);


  nr = clamp01(nr);
  ng = clamp01(ng);
  nb = clamp01(nb);


  float maxRGB =

    max(
      nr,
      max(
        ng,
        nb
      )
    );


  float minRGB =

    min(
      nr,
      min(
        ng,
        nb
      )
    );


  float chroma =
    maxRGB - minRGB;


  // ---------------------------------------------------
  // Neutral
  // ---------------------------------------------------

  if (
    chroma < 0.04
  ) {

    float clearNorm =

      (c - BLACK_C)
      /
      (WHITE_C - BLACK_C);


    clearNorm =
      clamp01(
        clearNorm
      );


#if CHROMAPOD_CALIBRATION_PROFILE == 14
    // Piecewise neutral luminance mapping through measured printed
    // black (CLEAR=169), mid-grey (663.2), light-grey (1564),
    // white (1777.16). Monotonic but sheet-specific and unvalidated.
    // Avoids the V13 single exponent compressing the light-grey patch.
    float grayLevel;
    if (c <= 663.2f) {
      grayLevel = 128.0f * clamp01((c - BLACK_C) / (663.2f - BLACK_C));
    } else if (c <= 1564.0f) {
      grayLevel = 128.0f + 89.0f * clamp01((c - 663.2f) / (1564.0f - 663.2f));
    } else {
      grayLevel = 217.0f + 38.0f * clamp01((c - 1564.0f) / (WHITE_C - 1564.0f));
    }
    int value = constrain((int)round(grayLevel), 0, 255);
#else
    float gray =

      pow(
        clearNorm,
        NEUTRAL_EXPONENT
      );


    int value =

      constrain(
        (int)round(
          gray * 255.0
        ),
        0,
        255
      );
#endif


    // Snap small near-black neutral measurement noise to zero.
    // V10/V11/V9 keep the existing 18-count tolerance unchanged.
    // New A4 profile uses a tighter 8-count tolerance, covering the
    // measured A4 black batch (Clear 145.0 to 153.6) without touching
    // chromatic scans or the mid-grey result.
#if CHROMAPOD_CALIBRATION_PROFILE == 12 || CHROMAPOD_CALIBRATION_PROFILE == 13 || CHROMAPOD_CALIBRATION_PROFILE == 14
    if (c <= BLACK_C + 8.0f) {
#else
    if (c <= BLACK_C + 18.0f) {
#endif
      value = 0;
    }

    R = value;
    G = value;
    B = value;
  }


  // ---------------------------------------------------
  // Chromatic
  // ---------------------------------------------------

  else {

    float correctedR =

        M_RR * nr

      + M_RG * ng

      + M_RB * nb;


    float correctedG =

       M_GR * nr

      + M_GG * ng

      + M_GB * nb;


    float correctedB =

       M_BR * nr

      + M_BG * ng

      + M_BB * nb;


    correctedR =
      clamp01(correctedR);

    correctedG =
      clamp01(correctedG);

    correctedB =
      clamp01(correctedB);


    R =

      constrain(
        (int)round(
          linearToSRGB(correctedR)
          *
          255.0
        ),
        0,
        255
      );


    G =

      constrain(
        (int)round(
          linearToSRGB(correctedG)
          *
          255.0
        ),
        0,
        255
      );


    B =

      constrain(
        (int)round(
          linearToSRGB(correctedB)
          *
          255.0
        ),
        0,
        255
      );
  }


#if CALIBRATION_SERIAL_LOG
  // One CSV line per physical scan. Raw RGBC values are
  // the averages of the five TCS34725 samples. Output RGB
  // is the existing, unchanged colour-processing result.
  Serial.printf(
    "CAL_SAMPLE,%.1f,%.1f,%.1f,%.1f,%d,%d,%d\n",
    r, g, b, c, R, G, B
  );
#endif
}


// =====================================================
// RGB -> HSL
// =====================================================

void rgbToHSL(
  int R,
  int G,
  int B,
  float &H,
  float &S,
  float &L
) {

  float r =
    R / 255.0;

  float g =
    G / 255.0;

  float b =
    B / 255.0;


  float maximum =

    max(
      r,
      max(
        g,
        b
      )
    );


  float minimum =

    min(
      r,
      min(
        g,
        b
      )
    );


  float delta =
    maximum - minimum;


  L =

    (
      maximum
      +
      minimum
    )
    /
    2.0;


  if (
    delta == 0
  ) {

    H = 0;

    S = 0;
  }

  else {

    float denominator =

      1.0
      -
      fabs(
        2.0 * L - 1.0
      );


    if (
      denominator <= 0.00001
    ) {

      S = 0;
    }

    else {

      S =
        delta
        /
        denominator;
    }


    if (
      maximum == r
    ) {

      H =

        60.0
        *
        fmod(
          (g - b)
          /
          delta,
          6.0
        );
    }

    else if (
      maximum == g
    ) {

      H =

        60.0
        *
        (
          (
            b - r
          )
          /
          delta
          +
          2.0
        );
    }

    else {

      H =

        60.0
        *
        (
          (
            r - g
          )
          /
          delta
          +
          4.0
        );
    }


    if (
      H < 0
    ) {

      H += 360.0;
    }
  }


  S *= 100.0;

  L *= 100.0;
}


// =====================================================
// RGB -> CMYK
// =====================================================

void rgbToCMYK(
  int R,
  int G,
  int B,
  float &C,
  float &M,
  float &Y,
  float &K
) {

  float r =
    R / 255.0;

  float g =
    G / 255.0;

  float b =
    B / 255.0;


  K =

    1.0
    -
    max(
      r,
      max(
        g,
        b
      )
    );


  if (
    K >= 0.999
  ) {

    C = 0;
    M = 0;
    Y = 0;
    K = 100;

    return;
  }


  C =

    (
      1.0
      -
      r
      -
      K
    )
    /
    (
      1.0
      -
      K
    );


  M =

    (
      1.0
      -
      g
      -
      K
    )
    /
    (
      1.0
      -
      K
    );


  Y =

    (
      1.0
      -
      b
      -
      K
    )
    /
    (
      1.0
      -
      K
    );


  C *= 100.0;
  M *= 100.0;
  Y *= 100.0;
  K *= 100.0;
}


// =====================================================
// RGB -> LAB
// =====================================================

float inverseSRGB(
  float value
) {

  value /=
    255.0;


  if (
    value <= 0.04045
  ) {

    return

      value
      /
      12.92;
  }


  return

    pow(
      (
        value
        +
        0.055
      )
      /
      1.055,
      2.4
    );
}


float labFunction(
  float t
) {

  if (
    t > 0.008856
  ) {

    return
      cbrt(t);
  }


  return

    (
      7.787 * t
    )

    +

    (
      16.0 / 116.0
    );
}


void rgbToLab(
  int R,
  int G,
  int B,
  float &L,
  float &A,
  float &BB
) {

  float r =
    inverseSRGB(R);

  float g =
    inverseSRGB(G);

  float b =
    inverseSRGB(B);


  float X =

      r * 0.4124

    + g * 0.3576

    + b * 0.1805;


  float Y =

      r * 0.2126

    + g * 0.7152

    + b * 0.0722;


  float Z =

      r * 0.0193

    + g * 0.1192

    + b * 0.9505;


  X /=
    0.95047;

  Y /=
    1.00000;

  Z /=
    1.08883;


  float fx =
    labFunction(X);

  float fy =
    labFunction(Y);

  float fz =
    labFunction(Z);


  L =

    116.0
    *
    fy
    -
    16.0;


  A =

    500.0
    *
    (
      fx - fy
    );


  BB =

    200.0
    *
    (
      fy - fz
    );
}


// =====================================================
// DELTA E 76
// =====================================================

float calculateDeltaE(
  int r1,
  int g1,
  int b1,
  int r2,
  int g2,
  int b2
) {

  float L1;
  float A1;
  float B1;

  float L2;
  float A2;
  float B2;


  rgbToLab(
    r1,
    g1,
    b1,
    L1,
    A1,
    B1
  );


  rgbToLab(
    r2,
    g2,
    b2,
    L2,
    A2,
    B2
  );


  float dL =
    L1 - L2;

  float dA =
    A1 - A2;

  float dB =
    B1 - B2;


  return

    sqrt(
      dL * dL
      +
      dA * dA
      +
      dB * dB
    );
}


// =====================================================
// SCANNING SCREEN
// =====================================================

void drawScanning() {

  tft.fillScreen(
    ST77XX_BLACK
  );


  drawHeader();


  centerText(
    "SCANNING",
    43,
    2
  );


  centerText(
    "HOLD STILL",
    76,
    1
  );


  drawFooter(
    "DO NOT MOVE"
  );
}


// =====================================================
// SCAN READY
// =====================================================

void drawScanReady() {

  tft.fillScreen(
    ST77XX_BLACK
  );


  drawHeader();


  centerText(
    "SCAN",
    33,
    2
  );


  centerText(
    "PLACE SAMPLE",
    67,
    1
  );


  centerText(
    "PRESS SCAN BUTTON",
    84,
    1
  );


  drawFooter(
    "PRESS KNOB:BACK"
  );
}


// =====================================================
// SCAN RESULT
// =====================================================

void drawScanResult() {

  tft.fillScreen(
    ST77XX_BLACK
  );


  drawHeader();


  uint16_t colour =

    tft.color565(
      scanR,
      scanG,
      scanB
    );


  tft.fillRoundRect(
    11,
    39,
    43,
    43,
    5,
    colour
  );


  tft.drawRoundRect(
    11,
    39,
    43,
    43,
    5,
    ST77XX_WHITE
  );


  tft.setTextColor(
    ST77XX_WHITE
  );


  // ---------------------------------------------------
  // HEX
  // ---------------------------------------------------

  if (
    scanFormat == 0
  ) {

    char hexColor[8];


    sprintf(
      hexColor,
      "#%02X%02X%02X",
      scanR,
      scanG,
      scanB
    );


    tft.setTextSize(1);


    tft.setCursor(
      65,
      40
    );


    tft.print(
      "HEX"
    );


    tft.setTextSize(2);


    tft.setCursor(
      63,
      58
    );


    tft.print(
      hexColor
    );
  }


  // ---------------------------------------------------
  // RGB
  // ---------------------------------------------------

  else if (
    scanFormat == 1
  ) {

    tft.setTextSize(1);


    tft.setCursor(
      66,
      35
    );


    tft.print(
      "RGB"
    );


    tft.setCursor(
      66,
      50
    );


    tft.print(
      "R "
    );

    tft.print(
      scanR
    );


    tft.setCursor(
      66,
      64
    );


    tft.print(
      "G "
    );

    tft.print(
      scanG
    );


    tft.setCursor(
      66,
      78
    );


    tft.print(
      "B "
    );

    tft.print(
      scanB
    );
  }


  // ---------------------------------------------------
  // HSL
  // ---------------------------------------------------

  else if (
    scanFormat == 2
  ) {

    float H;
    float S;
    float L;


    rgbToHSL(
      scanR,
      scanG,
      scanB,
      H,
      S,
      L
    );


    tft.setTextSize(1);


    tft.setCursor(
      66,
      35
    );


    tft.print(
      "HSL"
    );


    tft.setCursor(
      66,
      50
    );


    tft.print(
      "H "
    );

    tft.print(
      H,
      0
    );


    tft.setCursor(
      66,
      64
    );


    tft.print(
      "S "
    );

    tft.print(
      S,
      0
    );

    tft.print(
      "%"
    );


    tft.setCursor(
      66,
      78
    );


    tft.print(
      "L "
    );

    tft.print(
      L,
      0
    );

    tft.print(
      "%"
    );
  }


  // ---------------------------------------------------
  // CMYK
  // ---------------------------------------------------

  else if (
    scanFormat == 3
  ) {

    float C;
    float M;
    float Y;
    float K;


    rgbToCMYK(
      scanR,
      scanG,
      scanB,
      C,
      M,
      Y,
      K
    );


    tft.setTextSize(1);


    tft.setCursor(
      66,
      31
    );


    tft.print(
      "CMYK"
    );


    tft.setCursor(
      66,
      44
    );


    tft.print("C ");
    tft.print(C, 0);


    tft.setCursor(
      66,
      56
    );


    tft.print("M ");
    tft.print(M, 0);


    tft.setCursor(
      66,
      68
    );


    tft.print("Y ");
    tft.print(Y, 0);


    tft.setCursor(
      66,
      80
    );


    tft.print("K ");
    tft.print(K, 0);
  }


  // ---------------------------------------------------
  // LAB
  // ---------------------------------------------------

  else {

    float L;
    float A;
    float BB;


    rgbToLab(
      scanR,
      scanG,
      scanB,
      L,
      A,
      BB
    );


    tft.setTextSize(1);


    tft.setCursor(
      66,
      35
    );


    tft.print(
      "LAB"
    );


    tft.setCursor(
      66,
      50
    );


    tft.print("L ");
    tft.print(L, 1);


    tft.setCursor(
      66,
      64
    );


    tft.print("a ");
    tft.print(A, 1);


    tft.setCursor(
      66,
      78
    );


    tft.print("b ");
    tft.print(BB, 1);
  }


  drawFooter(
    "TURN:FORMAT PRESS:BACK"
  );
}


// =====================================================
// NORMAL SCAN
// =====================================================

void performScan() {

  drawScanning();


  delay(250);


  getColour(
    scanR,
    scanG,
    scanB,
    scanClear
  );


  scanHasResult = true;

  scanFormat = 0;


  drawScanResult();


  String packet =

    "SCAN,"
    +
    String(scanR)
    +
    ","
    +
    String(scanG)
    +
    ","
    +
    String(scanB)
    +
    ","
    +
    String(scanClear);


  sendBLE(
    packet
  );
}


// =====================================================
// COMPARE START
// =====================================================

void drawCompareReference() {

  tft.fillScreen(
    ST77XX_BLACK
  );


  drawHeader();


  centerText(
    "COMPARE",
    32,
    2
  );


  centerText(
    "SCAN REFERENCE",
    67,
    1
  );


  centerText(
    "PRESS SCAN BUTTON",
    84,
    1
  );


  drawFooter(
    "PRESS KNOB:BACK"
  );
}


// =====================================================
// REFERENCE SAVED
// =====================================================

void drawReferenceSaved() {

  char hexColor[8];


  sprintf(
    hexColor,
    "#%02X%02X%02X",
    refR,
    refG,
    refB
  );


  tft.fillScreen(
    ST77XX_BLACK
  );


  drawHeader();


  uint16_t colour =

    tft.color565(
      refR,
      refG,
      refB
    );


  tft.fillRoundRect(
    13,
    38,
    40,
    40,
    5,
    colour
  );


  tft.drawRoundRect(
    13,
    38,
    40,
    40,
    5,
    ST77XX_WHITE
  );


  tft.setTextColor(
    ST77XX_WHITE
  );


  tft.setTextSize(1);


  tft.setCursor(
    64,
    38
  );


  tft.print(
    "REFERENCE"
  );


  tft.setTextSize(2);


  tft.setCursor(
    63,
    56
  );


  tft.print(
    hexColor
  );


  centerText(
    "NOW SCAN SAMPLE",
    88,
    1
  );


  drawFooter(
    "SCAN:SAMPLE PRESS:BACK"
  );
}


// =====================================================
// SAMPLE SAVED
// =====================================================

void drawSampleSaved() {

  char hexColor[8];


  sprintf(
    hexColor,
    "#%02X%02X%02X",
    sampleR,
    sampleG,
    sampleB
  );


  tft.fillScreen(
    ST77XX_BLACK
  );


  drawHeader();


  uint16_t colour =

    tft.color565(
      sampleR,
      sampleG,
      sampleB
    );


  tft.fillRoundRect(
    13,
    34,
    40,
    40,
    5,
    colour
  );


  tft.drawRoundRect(
    13,
    34,
    40,
    40,
    5,
    ST77XX_WHITE
  );


  tft.setTextColor(
    ST77XX_WHITE
  );


  tft.setTextSize(1);


  tft.setCursor(
    64,
    35
  );


  tft.print(
    "SAMPLE"
  );


  tft.setTextSize(2);


  tft.setCursor(
    63,
    53
  );


  tft.print(
    hexColor
  );


  centerText(
    "SAMPLE SAVED",
    81,
    1
  );


  centerText(
    "PRESS SCAN FOR RESULT",
    94,
    1
  );


  drawFooter(
    "SCAN:RESULT PRESS:BACK"
  );
}


// =====================================================
// COMPARE LABEL
// =====================================================

const char* getCompareLabel(
  float deltaE
) {

  // Screen displays one decimal.
  // If it visually displays 0.0 -> MATCH.

  if (
    deltaE < 0.05
  ) {

    return "MATCH";
  }


  if (
    deltaE < 2.0
  ) {

    return "VERY CLOSE";
  }


  if (
    deltaE < 5.0
  ) {

    return "CLOSE MATCH";
  }


  if (
    deltaE < 10.0
  ) {

    return "NOTICEABLE";
  }


  return "DIFFERENT";
}


// =====================================================
// TWO-COLOUR RESULT UI (128 high x 160 wide)
// =====================================================
// Applied ONLY to Compare's final result screen and the optional
// Image Match result received from CHROMA Studio.
// Existing home, scan and Compare acquisition screens are unchanged.
//
// Three rotary result pages:
// 0: split-circle colours / estimated similarity / dE
// 1: two colour swatches / HEX / dE
// 2: two colour swatches / RGB / dE
//
// Note: percent similarity is a UI heuristic, not a standard metric:
// estimate = clamp(round(100 - 2 * deltaE), 0, 100).
// Compare dE = CIE76 (as before); Image Match dE is app-supplied dE00.
// =====================================================

int estimatedMatchPercent(float deltaE, const char* deltaLabel) {
  if (!isfinite(deltaE)) return 0;

  // ΔE76 for physical COMPARE: preserve the existing estimate.
  // ΔE00 for IMAGE MATCH: align with the current app's observed
  // 33% when ΔE00 is 13.45. This 5x mapping is a UI heuristic,
  // not a standardized colour-match percentage.
  // Verify against the exact CHROMA Studio scoring function.
  const float scale = (strcmp(deltaLabel, "dE00") == 0) ? 5.0f : 2.0f;
  float score = 100.0f - scale * deltaE;
  return constrain((int)roundf(score), 0, 100);
}

void drawPairText(const String &value, int x, int y,
                  uint16_t colour = ST77XX_WHITE, int textSize = 1) {
  tft.setTextSize(textSize);
  tft.setTextColor(colour);
  tft.setCursor(x, y);
  tft.print(value);
}

void drawPairColourCircle(int x, int y, int radius,
                          uint16_t leftColour, uint16_t rightColour) {
  // Each scan colour occupies exactly one half of a circular swatch.
  for (int dx = -radius; dx <= radius; ++dx) {
    int dy = (int)sqrtf((float)(radius * radius - dx * dx));
    tft.drawFastVLine(x + dx, y - dy, dy * 2 + 1,
                      dx < 0 ? leftColour : rightColour);
  }
  tft.drawCircle(x, y, radius, ST77XX_WHITE);
}

void drawColourPairResult(
    const char* title,
    const char* leftLabel, int leftR, int leftG, int leftB,
    const char* rightLabel, int rightR, int rightG, int rightB,
    float deltaE, int page, const char* deltaLabel) {
  tft.fillScreen(ST77XX_BLACK);
  drawHeader();

  uint16_t leftColour = tft.color565(leftR, leftG, leftB);
  uint16_t rightColour = tft.color565(rightR, rightG, rightB);
  const char* quality = getCompareLabel(deltaE);

  char leftHex[8];
  char rightHex[8];
  snprintf(leftHex, sizeof(leftHex), "#%02X%02X%02X", leftR, leftG, leftB);
  snprintf(rightHex, sizeof(rightHex), "#%02X%02X%02X", rightR, rightG, rightB);

  // Heading fully inside y=20..107 content region.
  centerText(String(title), 21, 1, ST77XX_WHITE);

  if (page == 0) {
    // Split-colour circle and central match percentage.
    drawPairColourCircle(80, 58, 26, leftColour, rightColour);
    drawPairText(leftLabel, 8, 54, ST77XX_WHITE, 1);
    // Keep right label inside 160px even when 'SAMPLE' is used.
    int rightX = 152 - (int)strlen(rightLabel) * 6;
    drawPairText(rightLabel, rightX, 54, ST77XX_WHITE, 1);

    String matchText = String(estimatedMatchPercent(deltaE, deltaLabel)) + "%";
    int textWidth = matchText.length() * 12;
    tft.fillRoundRect(80 - (textWidth + 2) / 2, 50,
                      textWidth + 2, 19, 3, ST77XX_BLACK);
    drawPairText(matchText, 80 - textWidth / 2, 52, ST77XX_WHITE, 2);

    centerText(String(quality), 88, 1, ST77XX_YELLOW);
    centerText(String(deltaLabel) + " " + String(deltaE, 1), 98, 1);

  } else if (page == 1) {
    // Two large, equally sized colour swatches with HEX values.
    drawPairText(leftLabel, 8 + (68 - (int)strlen(leftLabel) * 6) / 2, 36);
    int rightX = 84 + (68 - (int)strlen(rightLabel) * 6) / 2;
    drawPairText(rightLabel, rightX, 36);

    tft.fillRoundRect(8, 48, 68, 32, 4, leftColour);
    tft.drawRoundRect(8, 48, 68, 32, 4, ST77XX_WHITE);
    tft.fillRoundRect(84, 48, 68, 32, 4, rightColour);
    tft.drawRoundRect(84, 48, 68, 32, 4, ST77XX_WHITE);

    drawPairText(String(leftHex), 8 + (68 - 42) / 2, 84);
    drawPairText(String(rightHex), 84 + (68 - 42) / 2, 84);
    centerText(String(deltaLabel) + " " + String(deltaE, 1), 99, 1);

  } else {
    // RGB page. All rows live above the divider at y=108.
    drawPairText(leftLabel, 8 + (68 - (int)strlen(leftLabel) * 6) / 2, 34);
    int rightX = 84 + (68 - (int)strlen(rightLabel) * 6) / 2;
    drawPairText(rightLabel, rightX, 34);

    tft.fillRoundRect(10, 46, 22, 17, 3, leftColour);
    tft.drawRoundRect(10, 46, 22, 17, 3, ST77XX_WHITE);
    tft.fillRoundRect(128, 46, 22, 17, 3, rightColour);
    tft.drawRoundRect(128, 46, 22, 17, 3, ST77XX_WHITE);

    drawPairText(String("R ") + String(leftR), 9, 67);
    drawPairText(String("G ") + String(leftG), 9, 78);
    drawPairText(String("B ") + String(leftB), 9, 89);

    drawPairText(String("R ") + String(rightR), 89, 67);
    drawPairText(String("G ") + String(rightG), 89, 78);
    drawPairText(String("B ") + String(rightB), 89, 89);
    centerText(String(deltaLabel) + " " + String(deltaE, 1), 99, 1);
  }

  drawFooter("TURN:VIEW  KNOB:BACK");
}

void drawCompareResult(float deltaE) {
  drawColourPairResult(
      compareResultPage == 0 ? "COMPARE  EST.%" :
      (compareResultPage == 1 ? "COMPARE  HEX" : "COMPARE  RGB"),
      "REF", refR, refG, refB,
      "SAMPLE", sampleR, sampleG, sampleB,
      deltaE, compareResultPage, "dE76");
}

void drawImageMatchResult() {
  drawColourPairResult(
      imResultPage == 0 ? "IMAGE MATCH EST.%" :
      (imResultPage == 1 ? "IMAGE MATCH HEX" : "IMAGE MATCH RGB"),
      "TARGET", imTargetR, imTargetG, imTargetB,
      "SCAN", imR, imG, imB,
      imAppDeltaE, imResultPage, "dE00");
}

// =====================================================
// COMPARE ACTION
// =====================================================

void handleCompareScan() {

  // ---------------------------------------------------
  // Result visible:
  // next Scan immediately starts a new reference
  // ---------------------------------------------------

  if (
    compareResultShowing
  ) {

    compareResultShowing = false;

    compareStage = 0;
  }


  // ---------------------------------------------------
  // Stage 0: Reference
  // ---------------------------------------------------

  if (
    compareStage == 0
  ) {

    drawScanning();


    delay(250);


    getColour(
      refR,
      refG,
      refB,
      refClear
    );


    compareStage = 1;


    drawReferenceSaved();


    String packet =

      "REF,"
      +
      String(refR)
      +
      ","
      +
      String(refG)
      +
      ","
      +
      String(refB);


    sendBLE(
      packet
    );


    return;
  }


  // ---------------------------------------------------
  // Stage 1: Sample
  // ---------------------------------------------------

  if (
    compareStage == 1
  ) {

    drawScanning();


    delay(250);


    getColour(
      sampleR,
      sampleG,
      sampleB,
      sampleClear
    );


    compareStage = 2;


    drawSampleSaved();


    return;
  }


  // ---------------------------------------------------
  // Stage 2:
  //
  // PROCEED ONLY.
  // NO THIRD SENSOR READING.
  // ---------------------------------------------------

  if (
    compareStage == 2
  ) {

    lastDeltaE =

      calculateDeltaE(
        refR,
        refG,
        refB,
        sampleR,
        sampleG,
        sampleB
      );


    compareResultShowing = true;

    compareResultPage = 0;
    compareStage = 0;


    drawCompareResult(
      lastDeltaE
    );


    String packet =

      "CMP,"
      +
      String(sampleR)
      +
      ","
      +
      String(sampleG)
      +
      ","
      +
      String(sampleB)
      +
      ","
      +
      String(
        lastDeltaE,
        1
      );


    sendBLE(
      packet
    );


    return;
  }
}


// =====================================================
// IMAGE MATCH UI - non-overlapping 160x128 layouts
// =====================================================
void drawImageMatchStatus() {
  if (imHasAppResult && imPhysicalSaved) {
    drawImageMatchResult();
    return;
  }

  tft.fillScreen(ST77XX_BLACK);
  drawHeader();

  if (imPhysicalSaved) {
    // Left swatch ends at y=77; all messages start at y=85.
    centerText("IMAGE MATCH", 24, 1);
    uint16_t colour = tft.color565(imR, imG, imB);
    tft.fillRoundRect(12, 42, 38, 35, 4, colour);
    tft.drawRoundRect(12, 42, 38, 35, 4, ST77XX_WHITE);

    char hexColor[8];
    snprintf(hexColor, sizeof(hexColor), "#%02X%02X%02X", imR, imG, imB);
    drawPairText("SCANNED", 58, 41);
    drawPairText(String(hexColor), 57, 55, ST77XX_WHITE, 1);

    if (!bleApproved) {
      centerText("SAMPLE SAVED", 85, 1, ST77XX_YELLOW);
      centerText("CONNECT CHROMA STUDIO", 97, 1);
    } else if (imPendingSend) {
      centerText("WAITING TO SEND", 85, 1, ST77XX_YELLOW);
      centerText("KEEP APP CONNECTED", 97, 1);
    } else {
      centerText("SENT TO APP", 85, 1, ST77XX_GREEN);
      centerText("WAIT FOR MATCH RESULT", 97, 1);
    }
    drawFooter("SCAN:RETRY KNOB:BACK");
    return;
  }

  centerText("IMAGE MATCH", 27, 2);
  if (bleApproved) {
    centerText("APP CONNECTED", 54, 1, ST77XX_GREEN);
    centerText("PICK IMAGE + TARGET", 70, 1);
    centerText("IN CHROMA STUDIO", 82, 1);
    centerText("PRESS SCAN TO CAPTURE", 96, 1);
  } else {
    centerText("APP NOT CONNECTED", 55, 1, ST77XX_YELLOW);
    centerText("CONNECT CHROMA STUDIO", 73, 1);
    centerText("OR SCAN TO SAVE", 91, 1);
  }
  drawFooter("SCAN:CAPTURE KNOB:BACK");
}

// =====================================================
// IMAGE MATCH PACKET
// =====================================================

void sendImageMatchPacket() {

  String packet =

    "SCAN,"
    +
    String(imR)
    +
    ","
    +
    String(imG)
    +
    ","
    +
    String(imB)
    +
    ","
    +
    String(imClear);


  if (
    sendBLE(
      packet
    )
  ) {

    imPendingSend = false;
  }
}


// =====================================================
// IMAGE MATCH SCAN
// =====================================================

void performImageMatchScan() {

  drawScanning();


  delay(250);


  getColour(
    imR,
    imG,
    imB,
    imClear
  );


  imPhysicalSaved = true;
  imHasAppResult = false; // Previous image/target must not leak into a rescan.
  imResultPage = 0;

  imPendingSend = true;


  if (
    bleApproved
  ) {

    sendImageMatchPacket();
  }


  drawImageMatchStatus();
}


// =====================================================
// DRAW CURRENT SCREEN
// =====================================================

void drawCurrentScreen() {

  if (
    currentMode == MODE_HOME
  ) {

    drawMenu();

    return;
  }


  if (
    currentMode == MODE_SCAN
  ) {

    if (
      scanHasResult
    ) {

      drawScanResult();
    }

    else {

      drawScanReady();
    }

    return;
  }


  if (
    currentMode == MODE_COMPARE
  ) {

    if (
      compareResultShowing
    ) {

      drawCompareResult(
        lastDeltaE
      );
    }

    else if (
      compareStage == 0
    ) {

      drawCompareReference();
    }

    else if (
      compareStage == 1
    ) {

      drawReferenceSaved();
    }

    else {

      drawSampleSaved();
    }

    return;
  }


  if (
    currentMode == MODE_IMAGE_MATCH
  ) {

    drawImageMatchStatus();

    return;
  }
}


// =====================================================
// CONNECTION APPROVAL
// =====================================================

void approveConnection() {

  if (
    !bleLinkConnected
  ) {

    connectionPromptVisible = false;

    drawCurrentScreen();

    return;
  }


  bleApproved = true;

  connectionPromptVisible = false;

  bleApprovedAt =
    millis();


  Serial.println(
    "USER APPROVED BLE CONNECTION"
  );


  // Small confirmation screen

  tft.fillScreen(
    ST77XX_BLACK
  );


  drawHeader();


  centerText(
    "CONNECTED",
    48,
    2,
    ST77XX_GREEN
  );


  centerText(
    "CHROMA STUDIO",
    76,
    1
  );


  delay(600);


  drawCurrentScreen();
}


void rejectConnection() {

  connectionPromptVisible = false;

  bleApproved = false;


  Serial.println(
    "USER CANCELLED BLE CONNECTION"
  );


  tft.fillScreen(
    ST77XX_BLACK
  );


  drawHeader();


  centerText(
    "CANCELLED",
    50,
    2,
    ST77XX_YELLOW
  );


  delay(450);


  // Disconnect the current central.

  if (
    bleLinkConnected
  ) {

    uint16_t connectionId =

      chromaServer->getConnId();


    chromaServer->disconnect(
      connectionId
    );
  }


  drawCurrentScreen();
}


// =====================================================
// BLE EVENT PROCESSING
// =====================================================

void processBLEEvents() {

  // ---------------------------------------------------
  // Incoming connection request
  // ---------------------------------------------------

  if (
    bleConnectEvent
  ) {

    bleConnectEvent = false;


    connectionChoice = 0;

    connectionPromptVisible = true;


    drawConnectionPrompt();
  }


  // ---------------------------------------------------
  // Disconnected
  // ---------------------------------------------------

  if (
    bleDisconnectEvent
  ) {

    bleDisconnectEvent = false;


    connectionPromptVisible = false;

    bleApproved = false;


    // Keep CHROMAPOD discoverable for next attempt.

    delay(100);


    startChromaAdvertising();


    drawCurrentScreen();
  }


  // ---------------------------------------------------
  // App-provided IMAGE MATCH result, transferred safely from BLE task.
  // ---------------------------------------------------
  int packetR = 0, packetG = 0, packetB = 0;
  float packetDelta = 0.0f;
  bool gotPacket = false;
  portENTER_CRITICAL(&imCommandMux);
  if (imResultPacketPending) {
    packetR = imPendingR;
    packetG = imPendingG;
    packetB = imPendingB;
    packetDelta = imPendingDeltaE;
    imResultPacketPending = false;
    gotPacket = true;
  }
  portEXIT_CRITICAL(&imCommandMux);

  if (gotPacket) {
    if (imPhysicalSaved && bleApproved) {
      imTargetR = packetR;
      imTargetG = packetG;
      imTargetB = packetB;
      imAppDeltaE = packetDelta;
      imHasAppResult = true;
      imPendingSend = false; // App already received this sample and matched it.
      imResultPage = 0;
      Serial.println("IMAGE MATCH RESULT READY");
      if (currentMode == MODE_IMAGE_MATCH && !connectionPromptVisible) {
        drawImageMatchStatus();
      }
    } else {
      Serial.println("IMRESULT ignored: scan/app approval missing");
    }
  }

  // ---------------------------------------------------
  // Image Match sample was taken offline.
  //
  // Send after approval once app has had time
  // to subscribe to BLE notifications.
  // ---------------------------------------------------

  if (
    bleApproved
    &&
    imPendingSend
    &&
    millis() - bleApprovedAt > 1200
  ) {

    sendImageMatchPacket();


    if (
      currentMode == MODE_IMAGE_MATCH
    ) {

      drawImageMatchStatus();
    }
  }
}


// =====================================================
// ENTER MODE
// =====================================================

void enterSelectedMode() {

  // SCAN

  if (
    selectedMenu == 0
  ) {

    currentMode =
      MODE_SCAN;


    scanHasResult = false;

    scanFormat = 0;


    drawScanReady();

    return;
  }


  // COMPARE

  if (
    selectedMenu == 1
  ) {

    currentMode =
      MODE_COMPARE;


    compareStage = 0;

    compareResultShowing = false;
    compareResultPage = 0;

    drawCompareReference();

    return;
  }


  // IMAGE MATCH

  currentMode =
    MODE_IMAGE_MATCH;
  imResultPage = 0;

  drawImageMatchStatus();
}


// =====================================================
// BACK TO HOME
// =====================================================

void goHome() {

  currentMode =
    MODE_HOME;


  scanHasResult = false;

  compareStage = 0;

  compareResultShowing = false;


  drawMenu();
}


// =====================================================
// BLE SETUP
// =====================================================

void setupBLE() {

  BLEDevice::init(
    "CHROMA"
  );


  BLEDevice::setMTU(
    64
  );


  chromaServer =

    BLEDevice::createServer();


  chromaServer->setCallbacks(
    new ChromaServerCallbacks()
  );


  BLEService* service =

    chromaServer->createService(
      CHROMA_SERVICE_UUID
    );


  // ---------------------------------------------------
  // DATA
  // ---------------------------------------------------

  dataCharacteristic =

    service->createCharacteristic(

      CHROMA_DATA_UUID,

      BLECharacteristic::PROPERTY_READ
      |
      BLECharacteristic::PROPERTY_NOTIFY
    );


  dataCharacteristic->addDescriptor(
    new BLE2902()
  );


  dataCharacteristic->setValue(
    "READY"
  );


  // ---------------------------------------------------
  // COMMAND
  // ---------------------------------------------------

  commandCharacteristic =

    service->createCharacteristic(

      CHROMA_COMMAND_UUID,

      BLECharacteristic::PROPERTY_READ
      |
      BLECharacteristic::PROPERTY_WRITE
    );


  commandCharacteristic->setCallbacks(
    new CommandCallbacks()
  );


  commandCharacteristic->setValue(
    "READY"
  );


  service->start();


  // ---------------------------------------------------
  // ADVERTISING
  // ---------------------------------------------------

  chromaAdvertising =

    BLEDevice::getAdvertising();


  chromaAdvertising->addServiceUUID(
    CHROMA_SERVICE_UUID
  );


  chromaAdvertising->setScanResponse(
    true
  );


  // Device is discoverable immediately.
  //
  // When phone connects, CHROMAPOD asks user:
  //
  // CONNECT APP?
  // YES / CANCEL

  startChromaAdvertising();


  Serial.println(
    "CHROMAPOD BLE READY"
  );
}


// =====================================================
// SETUP
// =====================================================

void setup() {

  Serial.begin(
    115200
  );

#if CHROMAPOD_CALIBRATION_PROFILE == 9
  Serial.println("CAL_PROFILE,V9_ORIGINAL");
#elif CHROMAPOD_CALIBRATION_PROFILE == 10
  Serial.println("CAL_PROFILE,V10_TEST_PRINTED_SWATCHES");
#elif CHROMAPOD_CALIBRATION_PROFILE == 11
  Serial.println("CAL_PROFILE,V11_EXPERIMENTAL_SWATCH_FIT");
#elif CHROMAPOD_CALIBRATION_PROFILE == 12
  Serial.println("CAL_PROFILE,V12_A4_NORMAL_PAPER_TEST");
#elif CHROMAPOD_CALIBRATION_PROFILE == 13
  Serial.println("CAL_PROFILE,V13_A4_CURRENT_CONTACT_TEST");
#elif CHROMAPOD_CALIBRATION_PROFILE == 14
  Serial.println("CAL_PROFILE,V14_A4_16_SWATCH_EXPERIMENTAL");
#endif


  // ---------------------------------------------------
  // Buttons
  // ---------------------------------------------------

  pinMode(
    SCAN_BUTTON,
    INPUT_PULLUP
  );


  pinMode(
    ENC_CLK,
    INPUT_PULLUP
  );


  pinMode(
    ENC_DT,
    INPUT_PULLUP
  );


  pinMode(
    ENC_SW,
    INPUT_PULLUP
  );


#if BATTERY_MONITOR_ENABLED

  pinMode(
    BATTERY_PIN,
    INPUT
  );


  analogSetPinAttenuation(
    BATTERY_PIN,
    ADC_11db
  );

#endif


  // ---------------------------------------------------
  // I2C
  // ---------------------------------------------------

  Wire.begin(
    21,
    22
  );


  // ---------------------------------------------------
  // SPI
  // ---------------------------------------------------

  SPI.begin(
    18,
    -1,
    23,
    TFT_CS
  );


  // ---------------------------------------------------
  // TFT
  // ---------------------------------------------------

  tft.initR(
    INITR_BLACKTAB
  );


  tft.setRotation(
    1
  );


  // ---------------------------------------------------
  // BOOT
  //
  // ONLY CHROMAPOD.
  // No tagline.
  // ---------------------------------------------------

  drawBootScreen();


  delay(900);


  // ---------------------------------------------------
  // SENSOR
  // ---------------------------------------------------

  if (
    !tcs.begin()
  ) {

    tft.fillScreen(
      ST77XX_BLACK
    );


    centerText(
      "SENSOR",
      44,
      2
    );


    centerText(
      "ERROR",
      70,
      2,
      ST77XX_RED
    );


    while (1) {

      delay(1000);
    }
  }


  // ---------------------------------------------------
  // Rotary initial state
  // ---------------------------------------------------

  encoderState =

    (
      digitalRead(ENC_CLK)
      <<
      1
    )

    |

    digitalRead(ENC_DT);


  // ---------------------------------------------------
  // BLE
  // ---------------------------------------------------

  setupBLE();


  delay(150);


  // ---------------------------------------------------
  // HOME
  // ---------------------------------------------------

  currentMode =
    MODE_HOME;


  drawMenu();
}


// =====================================================
// LOOP
// =====================================================

void loop() {

  processBLEEvents();


  // ===================================================
  // CONNECTION POPUP HAS PRIORITY
  // ===================================================

  if (
    connectionPromptVisible
  ) {

    int step =
      readEncoderStep();


    if (
      step != 0
    ) {

      connectionChoice =
        1 - connectionChoice;


      drawConnectionPrompt();
    }


    if (
      buttonPressed(
        ENC_SW
      )
    ) {

      if (
        connectionChoice == 0
      ) {

        approveConnection();
      }

      else {

        rejectConnection();
      }
    }


    return;
  }


  // ===================================================
  // HOME
  // ===================================================

  if (
    currentMode == MODE_HOME
  ) {

    int step =
      readEncoderStep();


    if (
      step != 0
    ) {

      selectedMenu +=
        step;


      if (
        selectedMenu >= MENU_COUNT
      ) {

        selectedMenu = 0;
      }


      if (
        selectedMenu < 0
      ) {

        selectedMenu =
          MENU_COUNT - 1;
      }


      drawMenu();
    }


    if (
      buttonPressed(
        ENC_SW
      )
    ) {

      enterSelectedMode();
    }


    return;
  }


  // ===================================================
  // ROTARY PRESS = BACK
  // ===================================================

  if (
    buttonPressed(
      ENC_SW
    )
  ) {

    goHome();

    return;
  }


  // ===================================================
  // ROTARY TURN
  // ===================================================

  int step =
    readEncoderStep();


  // Scan result format

  if (
    currentMode == MODE_SCAN
    &&
    scanHasResult
    &&
    step != 0
  ) {

    scanFormat +=
      step;


    if (
      scanFormat >=
      SCAN_FORMAT_COUNT
    ) {

      scanFormat = 0;
    }


    if (
      scanFormat < 0
    ) {

      scanFormat =
        SCAN_FORMAT_COUNT - 1;
    }


    drawScanResult();
  }

  // Compare result: rotate through split circle, HEX and RGB.
  if (currentMode == MODE_COMPARE && compareResultShowing && step != 0) {
    compareResultPage = (compareResultPage + (step > 0 ? 1 : 2)) % 3;
    drawCompareResult(lastDeltaE);
  }

  // Image Match result: same rotary pages using the app's dE00.
  if (currentMode == MODE_IMAGE_MATCH && imHasAppResult && step != 0) {
    imResultPage = (imResultPage + (step > 0 ? 1 : 2)) % 3;
    drawImageMatchStatus();
  }

  // ===================================================
  // TACTILE SCAN BUTTON
  // ===================================================

  if (
    buttonPressed(
      SCAN_BUTTON
    )
  ) {

    // -------------------------------------------------
    // SCAN
    // -------------------------------------------------

    if (
      currentMode == MODE_SCAN
    ) {

      performScan();

      return;
    }


    // -------------------------------------------------
    // COMPARE
    // -------------------------------------------------

    if (
      currentMode == MODE_COMPARE
    ) {

      handleCompareScan();

      return;
    }


    // -------------------------------------------------
    // IMAGE MATCH
    // -------------------------------------------------

    if (
      currentMode == MODE_IMAGE_MATCH
    ) {

      performImageMatchScan();

      return;
    }
  }
}