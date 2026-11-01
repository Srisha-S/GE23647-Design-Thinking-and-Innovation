# CHROMA — Colour Intelligence
**Bridging Physical Colours and Digital Design**

**GE23647 – Design Thinking and Innovation | Team 9**

## About
CHROMA is an integrated hardware and software colour analysis system that captures physical colours and enables digital colour comparison, conversion, image matching and visualisation.

The system consists of:
- **CHROMAPOD:** A portable ESP32-based colour scanner using the TCS34725 sensor.
- **CHROMA Studio:** A React-based web and Android application for colour analysis and management.

Both components communicate through Bluetooth Low Energy (BLE).

## Key Features
- Physical colour scanning and RGB/HEX identification
- Colour comparison using CIE76 and CIEDE2000
- Colour format conversion
- Image colour matching and recolouring
- Colour library and project management

## Technologies
**Hardware:** ESP32-WROOM-32, TCS34725, ST7735 TFT, KY-040 Rotary Encoder

**Software:** React, TypeScript, Capacitor, BLE

## Project Results
Calibration testing on 16 printed colour references showed an improvement in mean RGB agreement from **85.02% (V13) to 94.68% (V14)** under the tested conditions.

## Repository Contents
- `hardware/` – ESP32 firmware
- `software/` – CHROMA Studio application
- `documentation/` – Project report 
- `presentation/` – Final project presentation
- `publication/` – Research paper
- `design-thinking/` – Empathy maps and design-thinking materials
- `images/` – images of prototype, application screenshots, report figures

## Project Team
**Branayaga A P | Srisha S**

**Guide:** Dr. P. Revathy  
Department of Computer Science and Design  
Rajalakshmi Engineering College, Chennai
