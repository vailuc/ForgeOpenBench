# Supported Hardware & Known Quirks

> This guide covers the hardware FOB currently talks to and the caveats you should know before plugging anything in.

---

## Supported Devices

| Device | Interface | What FOB Sees | Status |
|---|---|---|---|
| **Pokit Pro / Pokit Meter** | BLE (Web Bluetooth or Python bridge) | Full multimeter + 1-channel DSO + data logger | Tested on Linux |
| **Pokit Pro** | BLE (Python bridge) | Low-latency notifications bypass Chromium's BlueZ batching | Recommended on Linux |
| **Hantek 6022BL** | USB (sigrok fx2lafw) | 2-ch DSO + 16-ch LA in one dongle | Tested on Linux |
| **Hantek 6022BE** | USB (sigrok hantek-6xxx) | Classic 2-ch DSO | Expected to work |
| **Saleae Logic clones** | USB (sigrok fx2lafw) | Should work out of the box | Expected to work |
| **USB / IP webcam** | V4L2 / OpenCV | Live bench camera with manual controls | Tested on Linux |
| **Serial devices (Arduino, ESP32, RP2040)** | USB UART | MonitorForge reads `Serial.print()` output | Tested on Linux |
| **Rigol / Siglent SCPI scopes** | USB / LAN | Planned support | v1.2 |

---

## Platform Notes

**Linux (Arch)** is the only platform tested and proven for daily use. The install script is written to also detect Debian, Ubuntu, Raspberry Pi OS, macOS, and Windows-like environments, but those have not been validated by the project yet.

**macOS** is expected to work for Web Bluetooth and the Python BLE bridge, but it has not been tested.

**Windows** and **WSL** are expected to work, but USB device pass-through (especially for Hantek / FX2 logic analyzers) can be tricky. Community feedback is welcome.

**Tablets and phones** are remote browsers only. The FOB backend, bridges, and USB/BLE hardware must be connected to a real PC or SBC running the server.

---

## Hantek 6022BL Logic Analyzer Mode

The 6022BL enumerates at USB VID:PID `0925:3881`. This is the same VID:PID used by some Saleae Logic clones, so sigrok may load an 8-channel firmware variant with a fixed transfer count. When that happens, `sigrok-cli --continuous` exits after a small number of bulk transfers.

### The fix

FOB expects the 16-channel firmware `fx2lafw-sigrok-fx2-16ch.fw` (from `sigrok-firmware-fx2lafw`) to be present. The install script tries to install this package automatically.

If you still see the stream die immediately, open **Settings → WaveForge** in the FOB UI and switch the device mode between *8ch @ 24 MHz* and *16ch @ 12 MHz*. FOB manages the firmware symlink for you — no `sudo cp` required. Replug the device after switching.

If you prefer to manage firmware manually:

```bash
# Back up the original file first
sudo cp /usr/share/sigrok-firmware/fx2lafw-saleae-logic.fw \
        /usr/share/sigrok-firmware/fx2lafw-saleae-logic.fw.bak

# Replace with the 16-channel variant
sudo cp /usr/share/sigrok-firmware/fx2lafw-sigrok-fx2-16ch.fw \
        /usr/share/sigrok-firmware/fx2lafw-saleae-logic.fw

# Replug the device — firmware loads fresh on each plug
```

To restore the original 8-channel/24MHz behavior:

```bash
sudo cp /usr/share/sigrok-firmware/fx2lafw-saleae-logic.fw.bak \
        /usr/share/sigrok-firmware/fx2lafw-saleae-logic.fw
```

### How FOB avoids the re-enumeration race

FOB calls `sigrok-cli` with the bare `fx2lafw` driver and no `conn=` address. Calling `--scan` first triggers a firmware upload and re-enumeration, which can make any `conn=` address stale. Bare driver selection avoids that race.

---

## Hantek 6022BL Oscilloscope Mode

Press the **H/P** button on the 6022BL to toggle between logic-analyzer mode and oscilloscope mode. The LED changes color to indicate the active mode. In scope mode the device enumerates as `04B4:602A` (bare Cypress FX2). FOB uploads `hantek-6022bl-scope.fw` (Ho-Ro / rpcope1 firmware), which re-enumerates the device to `04B5:602A`. Direct bulk capture is then performed on EP6. No sigrok involvement is needed for this mode.

> **Note:** The button is a push-on/push-off toggle; you do not need to hold it while plugging the device in.

---

## USB Permissions

`install.sh` copies `server/usb-bridge/99-waveforge.rules` to `/etc/udev/rules.d/` and reloads udev. The rules grant non-root access to:

- Hantek `0925` devices
- Cypress FX2 bare chips `04b4`
- fx2lafw re-enumerated devices `1d50`

The rules set `MODE="0666"`, so the device is accessible by any user. They also reference `GROUP="plugdev"` for distros that use it. On Arch the standard group is `uucp`; being in both `plugdev` and `uucp` is fine and does not conflict. The install script creates `plugdev` if it is missing and adds you to it, but you may need to log out and back in for the group change to take effect.

---

## Camera Support

LensForge uses OpenCV / V4L2 to capture from any USB webcam or IP camera. There is no requirement for a phone camera; any UVC-compatible or V4L2-compatible device should work.

---

## Disclaimer

FOB is an independent, community project. It is not affiliated with, endorsed by, or certified by Pokit Innovations, Hantek, Saleae, sigrok, or any other vendor. It is not IEC, UL, CE, or safety certified and must not be used as a certified measurement instrument. Always follow the safety ratings of your hardware and use an isolated, rated instrument when measuring mains or high-energy circuits.

---

*Last updated: 2026-06-29*
