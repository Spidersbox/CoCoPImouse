const fs = require('fs');
const i2c = require('i2c-bus');
const Gpio = require('onoff').Gpio;

// 1. Hardware Interface Architecture Mappings
const DAC_X_ADDR = 0x60; // ADDR hardware pin tied to GND
const DAC_Y_ADDR = 0x61; // ADDR hardware pin scratched and tied to VCC
const MOUSE_DEVICE_PATH = '/dev/input/mice'; 

// 2. Sysfs Pin Allocations (Banana Pi M2 Ultra Header Maps)
// Pin 11 = GPIO 17 -> Left Button Transistor Base
// Pin 13 = GPIO 27 -> Right Button Transistor Base
const leftClickButton  = new Gpio(227, 'out');
const rightClickButton = new Gpio(226, 'out');

// Force button channels safe (0V / OPEN switch state) on boot
leftClickButton.writeSync(0);
rightClickButton.writeSync(0);

let i2cBus = null;
let mouseStream = null;
let isMouseActive = false;
let logTimeout = null;

// Coordinate Grid Tracker Memory Slots
let currentX = 32; // Center point boot defaults
let currentY = 32;
const scaleFactor = 20; // Your verified 1.5-inch desktop hand glide metric

try {
  // Bind to native hardware I2C bus 1 (Pins 3 and 5)
  i2cBus = i2c.openSync(1);
} catch (err) {
  // Swallows missing hardware errors so bench testing without chips is allowed
}

// 3. Automated DAC Power-Down Sequence (Enters High-Impedance / Hi-Z mode)
function powerDownDualDACs()
{
  try
  {
    if (i2cBus)
    {
//      const hizBuffer = Buffer.from([0x06, 0x00]); // 500k Ohm internal pull-down setup
      const hizBuffer = Buffer.from([0x46, 0x00, 0x00]); // 0x46 sets volatile write + Hi-Z separation
      i2cBus.i2cWriteSync(DAC_X_ADDR, hizBuffer.length, hizBuffer);
      i2cBus.i2cWriteSync(DAC_Y_ADDR, hizBuffer.length, hizBuffer);
    }
  } catch (e) {}
  
  // Force click transistors completely off so vintage joystick buttons can resume control
  leftClickButton.writeSync(0);
  rightClickButton.writeSync(0);
  
  console.log("\n=======================================================");
  console.log("   [STATUS] WIRELESS MOUSE DISCONNECTED / TURNED OFF");
  console.log("   --> DACs set to Hi-Z. CoCo Joystick port is now FREE! ");
  console.log("=======================================================");
}

// 4. Wake up DACs and reset to coordinate mid-points
function powerUpDualDACs()
{
  try
  {
    if (i2cBus)
    {
      const initBuffer = Buffer.from([0x40, 0x80, 0x00]); // Midscale target value 2048 (0x800)
      i2cBus.i2cWriteSync(DAC_X_ADDR, initBuffer.length, initBuffer);
      i2cBus.i2cWriteSync(DAC_Y_ADDR, initBuffer.length, initBuffer);
    }
  } catch (e) {}
  
  console.log("\n=======================================================");
  console.log("   [STATUS] WIRELESS MOUSE CONNECTED / POWERED ON");
  console.log("   --> Dual DACs initialized. Mouse overriding joysticks.");
  console.log("=======================================================");
}

// 5. Package and push standard 12-bit voltage scaling frames over I2C
function updateAxisDAC(address, coordinateValue) {
  try {
    if (!i2cBus) return;
    // Map our 0-63 scale straight onto the 12-bit DAC register (0 to 4095 matrix bounds)
    const dac12BitValue = Math.round((coordinateValue / 63) * 4095);
    
    const buf = Buffer.alloc(3);
    buf[0] = 0x40;                        // Command byte: Volatile register write
    buf[1] = (dac12BitValue >> 4) & 0xFF; // Grab high data bits
    buf[2] = (dac12BitValue << 4) & 0xF0; // Pad out low bits
    
    i2cBus.i2cWriteSync(address, buf.length, buf);
  } catch (e) {}
}

// 6. Active Linux Mouse Event Listener Thread
function startMouseStreaming() {
  if (mouseStream) return;

  mouseStream = fs.createReadStream(MOUSE_DEVICE_PATH);

  mouseStream.on('data', (buffer) => {
    if (buffer.length < 3) return;

    // A. Intercept Digital Button Bit Flags
    const isLeftPressed  = (buffer[0] & 0x01) !== 0;
    const isRightPressed = (buffer[0] & 0x02) !== 0;
    
    // B. Intercept Relative signed 8-bit velocity integers
    const deltaX         = buffer.readInt8(1);
    const deltaY         = buffer.readInt8(2);

    // Hard Logic Guard: Ignore zero-length background system flushes
    if (deltaX !== 0 || deltaY !== 0 || isLeftPressed || isRightPressed) {
      if (logTimeout) clearTimeout(logTimeout);

      if (!isMouseActive) {
        isMouseActive = true;
        powerUpDualDACs();
      }

      // Execute physical transistor button states instantly
      leftClickButton.writeSync(isLeftPressed ? 1 : 0);
      rightClickButton.writeSync(isRightPressed ? 1 : 0);

      // Accumulate relative movement and clamp strictly to CoCo 6-bit constraints
      currentX = Math.max(0, Math.min(63, currentX + Math.round(deltaX / scaleFactor)));
      currentY = Math.max(0, Math.min(63, currentY - Math.round(deltaY / scaleFactor))); // Invert Y axis

      updateAxisDAC(DAC_X_ADDR, currentX);
      updateAxisDAC(DAC_Y_ADDR, currentY);

      // Print live, self-overwriting coordinate tracking parameters
      const padX = String(currentX).padStart(2, ' ');
      const padY = String(currentY).padStart(2, ' ');
      const btnL = isLeftPressed ? '[L]' : '[ ]';
      const btnR = isRightPressed ? '[R]' : '[ ]';
      process.stdout.write(`\r[TRACKER] CoCo Grid -> X: ${padX} | Y: ${padY} | Buttons: ${btnL} ${btnR}   `);

      // Start the 2-second countdown window to safely release the joystick lines
      logTimeout = setTimeout(() => {
        isMouseActive = false;
        powerDownDualDACs();
        logTimeout = null;
      }, 2000);
    }
  });
}

// Fire up tracking thread
startMouseStreaming();

// 7. Clean Exit Framework
function cleanExit() {
  console.log("\n[SHUTDOWN] Unbinding hardware registers and exiting cleanly...");
  if (logTimeout) clearTimeout(logTimeout);
  
  if (mouseStream) {
    mouseStream.pause();
    mouseStream.removeAllListeners('data');
    mouseStream.destroy();
  }
  
  powerDownDualDACs();
  leftClickButton.unexport();
  rightClickButton.unexport();
  if (i2cBus) i2cBus.closeSync();
  process.exit(0);
}

process.on('SIGINT', cleanExit);
process.on('SIGTERM', cleanExit);

