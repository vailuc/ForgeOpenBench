# Firmware Files

These are FX2 / Cypress USB controller firmware images in Intel HEX format. They are loaded onto USB instruments at runtime by the WaveForge USB bridge.

## Files

| File | Device / purpose | Source / license |
|---|---|---|
| `fx2lafw-*.fw` | sigrok fx2lafw firmware variants for Cypress FX2 logic analyzers | From [sigrok-firmware-fx2lafw](https://sigrok.org/wiki/Fx2lafw), GPL-2.0-or-later / LGPL-2.1-or-later |
| `hantek-6022bl-scope.fw` | Hantek 6022BL oscilloscope mode firmware | Ho-Ro / OpenHantek 6022 community firmware; reverse-engineered Hantek scope commands; open source |

## Redistribution

All files here are open-source firmware distributed under FOSS licenses. They are redistributable in this form. See each upstream project for full license text.

If you replace a firmware file with your own build, update the `DEVICES` table in `usb_server.py` to match the resulting VID:PID.
