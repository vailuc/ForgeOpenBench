use anyhow::{Context, Result, bail};
use rusb::{DeviceHandle, GlobalContext};
use std::io::{self, Write};
use std::path::Path;
use std::thread;
use std::time::{Duration, Instant};

// ── USB IDs ──────────────────────────────────────────────────────────────
const VID_BARE: u16 = 0x04B4;
const PID_BARE: u16 = 0x602A;
const VID_SCOPE: u16 = 0x04B5;
const PID_SCOPE: u16 = 0x602A;

const BULK_IN_EP: u8 = 0x86; // EP6 IN

const FX2_UPLOAD: u8 = 0xA0;
const FX2_CPUCS: u16 = 0xE600;

// Hantek vendor commands
const CMD_STOP: u8 = 0xE3;
const CMD_SET_CH0_RANGE: u8 = 0xE0;
const CMD_SET_CH1_RANGE: u8 = 0xE1;
const CMD_SET_SAMPLERATE: u8 = 0xE2;
const CMD_SET_TEST_SIG: u8 = 0xE6;

// ── Intel HEX parser ───────────────────────────────────────────────────
fn parse_ihex(path: &Path) -> Result<Vec<(u16, Vec<u8>)>> {
    let text = std::fs::read_to_string(path)
        .with_context(|| format!("reading firmware {}", path.display()))?;

    let mut records = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if !line.starts_with(':') {
            continue;
        }
        let bytes = hex::decode(&line[1..])
            .with_context(|| format!("invalid hex in line: {line}"))?;

        if bytes.len() < 5 {
            bail!("ihex record too short");
        }

        let count = bytes[0] as usize;
        let addr = ((bytes[1] as u16) << 8) | (bytes[2] as u16);
        let rec_type = bytes[3];
        let data = &bytes[4..4 + count];

        // verify checksum
        let sum: u8 = bytes[..4 + count].iter().fold(0u8, |a, &b| a.wrapping_add(b));
        let checksum = bytes[4 + count];
        let calc = (0x100u16 - (sum as u16)) as u8;
        if calc != checksum {
            bail!("ihex checksum mismatch");
        }

        match rec_type {
            0x00 => records.push((addr, data.to_vec())), // data
            0x01 => break,                               // EOF
            _ => continue,
        }
    }
    Ok(records)
}

// ── FX2 firmware upload ────────────────────────────────────────────────
fn upload_firmware(handle: &mut DeviceHandle<GlobalContext>, path: &Path) -> Result<()> {
    let records = parse_ihex(path)?;

    // Assert CPU reset
    handle.write_control(
        0x40, FX2_UPLOAD, FX2_CPUCS, 0, &[0x01],
        Duration::from_secs(1),
    )?;
    thread::sleep(Duration::from_millis(50));

    // Upload each record
    for (addr, data) in records {
        const CHUNK: usize = 256;
        for (i, chunk) in data.chunks(CHUNK).enumerate() {
            let chunk_addr = addr + (i * CHUNK) as u16;
            handle.write_control(
                0x40, FX2_UPLOAD, chunk_addr, 0, chunk,
                Duration::from_secs(1),
            )?;
        }
    }

    // Release CPU reset → firmware runs, device renumerates
    handle.write_control(
        0x40, FX2_UPLOAD, FX2_CPUCS, 0, &[0x00],
        Duration::from_secs(1),
    )?;

    eprintln!("[hantek-capture] Firmware uploaded, waiting for renumeration...");
    thread::sleep(Duration::from_millis(1500));
    Ok(())
}

// ── Find device by VID/PID ─────────────────────────────────────────────
fn find_device(vid: u16, pid: u16) -> Result<DeviceHandle<GlobalContext>> {
    for dev in rusb::devices()?.iter() {
        let desc = dev.device_descriptor()?;
        if desc.vendor_id() == vid && desc.product_id() == pid {
            let handle = dev.open()?;
            // Detach kernel driver if present
            if let Ok(true) = handle.kernel_driver_active(0) {
                let _ = handle.detach_kernel_driver(0);
            }
            let _ = handle.claim_interface(0);
            return Ok(handle);
        }
    }
    bail!("Device {vid:04x}:{pid:04x} not found")
}

// ── Wait for device to appear ──────────────────────────────────────────
fn wait_for_device(vid: u16, pid: u16, timeout_secs: u64) -> Result<DeviceHandle<GlobalContext>> {
    let deadline = Instant::now() + Duration::from_secs(timeout_secs);
    while Instant::now() < deadline {
        for dev in rusb::devices()?.iter() {
            let desc = dev.device_descriptor()?;
            if desc.vendor_id() == vid && desc.product_id() == pid {
                let handle = dev.open()?;
                if let Ok(true) = handle.kernel_driver_active(0) {
                    let _ = handle.detach_kernel_driver(0);
                }
                let _ = handle.claim_interface(0);
                return Ok(handle);
            }
        }
        thread::sleep(Duration::from_millis(500));
    }
    bail!("Timeout waiting for device {vid:04x}:{pid:04x}")
}

// ── Hantek samplerate map (hz -> code) ─────────────────────────────────
fn rate_code_for_hz(hz: u32) -> u8 {
    let map: &[(u32, u8)] = &[
        (48_000_000, 48), (30_000_000, 30), (24_000_000, 24), (16_000_000, 16),
        (15_000_000, 15), (12_000_000, 12), (10_000_000, 10), (8_000_000, 8),
        (6_000_000, 6), (5_000_000, 5), (4_000_000, 4), (3_000_000, 3),
        (2_000_000, 2), (1_000_000, 1),
        (500_000, 50), (400_000, 40), (200_000, 20), (128_000, 113),
        (100_000, 10), (64_000, 106), (50_000, 105), (40_000, 104),
        (32_000, 103), (20_000, 102),
    ];
    *map.iter()
        .min_by_key(|(k, _)| if *k > hz { k - hz } else { hz - k })
        .map(|(_, v)| v)
        .unwrap_or(&4)
}

// ── Hantek voltage code ────────────────────────────────────────────────
fn volt_code_for_vpp(vpp: f64) -> u8 {
    match vpp {
        10.0 => 1,   // ±5V
        5.0  => 2,   // ±2.5V
        1.0  => 10,  // ±500mV
        _    => 5,   // ±1V (default, 2Vpp)
    }
}

// ── Encode calibration frequency ────────────────────────────────────────
fn encode_cal_freq(hz: u32) -> u8 {
    if hz >= 1000 {
        ((hz + 500) / 1000) as u8
    } else if hz >= 100 {
        ((hz + 50) / 100 + 200) as u8
    } else if hz >= 40 {
        ((hz + 5) / 10 + 100) as u8
    } else if hz == 32 {
        103
    } else {
        0
    }
}

// ── Configure and start Hantek DSO ───────────────────────────────────
fn hantek_setup(
    handle: &mut DeviceHandle<GlobalContext>,
    rate_hz: u32,
    vpp: f64,
    test_freq_hz: u32,
) -> Result<()> {
    let rate_code = rate_code_for_hz(rate_hz);
    let volt_code = volt_code_for_vpp(vpp);

    let cmd = |name: &str, req: u8, data: &[u8]| -> Result<()> {
        handle.write_control(0x40, req, 0, 0, data, Duration::from_secs(1))
            .with_context(|| format!("Hantek cmd {name} failed"))?;
        Ok(())
    };

    // Stop sampling
    cmd("STOP", CMD_STOP, &[0x00])?;
    thread::sleep(Duration::from_millis(50));

    // clear_halt is best-effort
    let _ = handle.clear_halt(BULK_IN_EP);
    thread::sleep(Duration::from_millis(50));

    // Configure
    cmd("CH0_RANGE", CMD_SET_CH0_RANGE, &[volt_code])?;
    thread::sleep(Duration::from_millis(10));
    cmd("CH1_RANGE", CMD_SET_CH1_RANGE, &[volt_code])?;
    thread::sleep(Duration::from_millis(10));
    cmd("SAMPLERATE", CMD_SET_SAMPLERATE, &[rate_code])?;
    thread::sleep(Duration::from_millis(10));

    // Test signal
    if test_freq_hz > 0 {
        let freq_byte = encode_cal_freq(test_freq_hz);
        cmd("TEST_SIG", CMD_SET_TEST_SIG, &[freq_byte])?;
        thread::sleep(Duration::from_millis(50));
    }

    // Start sampling
    cmd("START", CMD_STOP, &[0x01])?;

    eprintln!("[hantek-capture] Setup OK: rate={rate_hz} vpp={vpp}V test={test_freq_hz}Hz");
    Ok(())
}

// ── Write a binary frame to stdout ─────────────────────────────────────
fn write_frame(stdout: &mut io::StdoutLock, rate_hz: u32, data: &[u8], ts_us: u64) -> Result<()> {
    let n_bytes = data.len() as u32;
    let msg_len = 24 + n_bytes; // header + data

    let header: [u8; 24] = [
        (msg_len & 0xFF) as u8, ((msg_len >> 8) & 0xFF) as u8,
        ((msg_len >> 16) & 0xFF) as u8, ((msg_len >> 24) & 0xFF) as u8,
        (rate_hz & 0xFF) as u8, ((rate_hz >> 8) & 0xFF) as u8,
        ((rate_hz >> 16) & 0xFF) as u8, ((rate_hz >> 24) & 0xFF) as u8,
        (n_bytes & 0xFF) as u8, ((n_bytes >> 8) & 0xFF) as u8,
        ((n_bytes >> 16) & 0xFF) as u8, ((n_bytes >> 24) & 0xFF) as u8,
        (ts_us & 0xFF) as u8, ((ts_us >> 8) & 0xFF) as u8,
        ((ts_us >> 16) & 0xFF) as u8, ((ts_us >> 24) & 0xFF) as u8,
        ((ts_us >> 32) & 0xFF) as u8, ((ts_us >> 40) & 0xFF) as u8,
        ((ts_us >> 48) & 0xFF) as u8, ((ts_us >> 56) & 0xFF) as u8,
        0, 0, 0, 0, // reserved
    ];

    stdout.write_all(&header)?;
    stdout.write_all(data)?;
    stdout.flush()?;
    Ok(())
}

// ── Capture loop ───────────────────────────────────────────────────────
fn capture_loop(
    handle: &mut DeviceHandle<GlobalContext>,
    rate_hz: u32,
    read_size: usize,
) -> Result<()> {
    let mut stdout = io::stdout().lock();
    let timeout = Duration::from_millis(500);
    let mut consec_errors = 0u32;
    let mut frames = 0u64;
    let start = Instant::now();
    let mut last_report = start;

    eprintln!("[hantek-capture] Capture loop started, read_size={read_size}");

    loop {
        let t0 = Instant::now();
        let mut buf = vec![0u8; read_size];
        match handle.read_bulk(BULK_IN_EP, &mut buf, timeout) {
            Ok(n) if n > 0 => {
                let elapsed = t0.elapsed();
                consec_errors = 0;
                frames += 1;
                let ts_us = start.elapsed().as_micros() as u64;
                write_frame(&mut stdout, rate_hz, &buf[..n], ts_us)?;
                // Report timing every 1 second
                if t0.duration_since(last_report).as_secs_f64() >= 1.0 {
                    let total = start.elapsed().as_secs_f64();
                    let fps = frames as f64 / total;
                    eprintln!("[hantek-capture] read_bulk latency={:?} | frames={frames} fps={fps:.1}", elapsed);
                    last_report = t0;
                }
            }
            Ok(_) => {
                // zero-length read, continue
            }
            Err(rusb::Error::Timeout) => {
                // normal, continue
            }
            Err(e) => {
                consec_errors += 1;
                eprintln!("[hantek-capture] Bulk read error #{consec_errors}: {e}");
                // Keep retrying instead of dying; only the frontend/bridge should stop us.
                // If the device is truly gone, read_bulk will keep failing but the process
                // stays alive so the backend can terminate it cleanly.
            }
        }
    }
}

// ── CLI args ─────────────────────────────────────────────────────────────
struct Args {
    vid: u16,
    pid: u16,
    firmware: Option<String>,
    rate_hz: u32,
    vpp: f64,
    test_freq_hz: u32,
    read_size: usize,
}

fn parse_args() -> Result<Args> {
    let mut args = std::env::args().skip(1);
    let mut vid = VID_BARE;
    let mut pid = PID_BARE;
    let mut firmware: Option<String> = None;
    let mut rate_hz = 4_000_000u32;
    let mut vpp = 1.0f64;
    let mut test_freq_hz = 0u32;
    let mut read_size = 39_936usize; // 512*78 = 40KB (roll mode, tuned for <10ms frame time)

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--vid" => vid = u16::from_str_radix(&args.next().unwrap_or_default().replace("0x", ""), 16)?,
            "--pid" => pid = u16::from_str_radix(&args.next().unwrap_or_default().replace("0x", ""), 16)?,
            "--firmware" => firmware = args.next(),
            "--rate" => rate_hz = args.next().unwrap_or_default().parse()?,
            "--vpp" => vpp = args.next().unwrap_or_default().parse()?,
            "--test-freq" => test_freq_hz = args.next().unwrap_or_default().parse()?,
            "--read-size" => read_size = args.next().unwrap_or_default().parse()?,
            "--help" | "-h" => {
                eprintln!("Usage: hantek-capture [OPTIONS]");
                eprintln!("  --vid VID           Device VID (hex, default 04b4)");
                eprintln!("  --pid PID           Device PID (hex, default 602a)");
                eprintln!("  --firmware PATH     Intel HEX firmware to upload");
                eprintln!("  --rate HZ           Sample rate in Hz (default 4000000)");
                eprintln!("  --vpp VOLTS         Voltage range Vpp: 10|5|2|1 (default 1)");
                eprintln!("  --test-freq HZ      Test signal frequency, 0=off (default 0)");
                eprintln!("  --read-size BYTES   USB bulk read size (default 39936)");
                std::process::exit(0);
            }
            _ => {}
        }
    }

    Ok(Args { vid, pid, firmware, rate_hz, vpp, test_freq_hz, read_size })
}

// ── Main ───────────────────────────────────────────────────────────────
fn main() -> Result<()> {
    let args = parse_args()?;

    eprintln!("[hantek-capture] Looking for device {:04x}:{:04x}", args.vid, args.pid);

    // Phase 1: find and optionally upload firmware
    let mut handle = if let Some(fw_path) = &args.firmware {
        let mut h = find_device(args.vid, args.pid)?;
        upload_firmware(&mut h, Path::new(fw_path))?;
        // Device renumerates — wait for scope PID
        drop(h); // close handle so renumeration can happen
        wait_for_device(VID_SCOPE, PID_SCOPE, 15)?
    } else {
        find_device(args.vid, args.pid)?
    };

    eprintln!("[hantek-capture] Device open, configuring...");

    // Phase 2: configure Hantek
    hantek_setup(&mut handle, args.rate_hz, args.vpp, args.test_freq_hz)?;

    // Phase 3: capture
    capture_loop(&mut handle, args.rate_hz, args.read_size)?;

    Ok(())
}
