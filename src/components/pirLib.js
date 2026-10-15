/** PIR library **/
/** bugsounet **/

const { execFile, spawn } = require("node:child_process");

var log = () => { /* do nothing */ };

class PIR {
  constructor (config, callback) {
    this.config = config;
    this.callback = callback;
    this.default = {
      debug: false,
      gpio: 21,
      mode: 0
    };
    this.config = Object.assign({}, this.default, this.config);
    if (this.config.debug) log = (...args) => { console.log("[MMM-Pir] [LIB] [PIR]", ...args); };
    this.pir = null;
    this.running = false;
    this.pirChip = null;
    this.pirReadyToDetect = false;
  }

  start () {
    if (this.running) return;
    if (this.config.gpio === 0) return console.log("[MMM-Pir] [LIB] [PIR] Disabled.");
    switch (this.config.mode) {
      case 0:
        console.log("[MMM-Pir] [LIB] [PIR] Mode 0 Selected (gpiod tools)");
        this.gpiodDetect();
        break;
      case 1:
        console.log("[MMM-Pir] [LIB] [PIR] Mode 1 Selected (gpiozero)");
        this.gpiozeroDetect();
        break;
      default:
        console.warn(`[MMM-Pir] [LIB] [PIR] mode: ${this.config.mode} is not a valid value`);
        console.warn("[MMM-Pir] [LIB] [PIR] set mode 0");
        this.config.mode = 0;
        this.gpiodDetect();
        break;
    }
  }

  stop () {
    if (!this.running) return;
    this.pir?.kill();

    this.pir = null;
    this.running = false;
    this.callback("PIR_STOP");
    log("Stop");
  }

  gpiozeroDetect () {
    const { PythonShell } = require("python-shell");
    let options = {
      mode: "text",
      scriptPath: __dirname,
      pythonOptions: ["-u"],
      args: ["-g", this.config.gpio]
    };

    this.pir = new PythonShell("MotionSensor.py", options);
    this.callback("PIR_STARTED");
    console.log("[MMM-Pir] [LIB] [PIR] Started!");
    this.pirReadyToDetect = true;
    this.running = true;

    this.pir.on("message", (message) => {
      // detect pir
      switch (message) {
        case "Motion":
          log("Debug: Motion detect ready is", this.pirReadyToDetect);
          if (this.pirReadyToDetect) {
            log("Motion Detected");
            this.callback("PIR_DETECTED");
            this.pirReadyToDetect = false;
            log("Debug: Set motion detect ready to:", this.pirReadyToDetect);
          }
          break;
        case "NoMotion":
          log("No Motion Detected");
          this.pirReadyToDetect = true;
          log("Debug: Set motion detect ready to:", this.pirReadyToDetect);
          break;
        default:
          console.error("[MMM-Pir] [LIB] [PIR] ", message);
          this.callback("PIR_ERROR", message);
          this.running = false;
          break;
      }
    });

    this.pir.on("stderr", (stderr) => {
      // handle stderr (a line of text from stderr)
      if (this.config.debug) console.error("[MMM-Pir] [LIB] [PIR]", stderr);
      this.running = false;
    });

    this.pir.end((err, code, signal) => {
      if (err) {
        console.error("[MMM-Pir] [LIB] [PIR] [PYTHON]", err);
        this.callback("PIR_ERROR", err.message);
      }
      console.warn(`[MMM-Pir] [LIB] [PIR] [PYTHON] The exit code was: ${code}`);
      console.warn(`[MMM-Pir] [LIB] [PIR] [PYTHON] The exit signal was: ${signal}`);
    });
  }

  /* use gpiomon from libgpiod tools (apt package `gpiod`): works with libgpiod 1.x and 2.x */

  async gpiodDetect () {
    try {
      const version = await this.gpiodRun("gpiomon", ["--version"]);
      const major = Number((/\(libgpiod\) v(\d+)\./).exec(version)?.[1]);
      if (!major) throw new Error(`Unknown gpiomon version: ${version.split("\n")[0]}`);
      log(`[GPIOD] gpiomon libgpiod v${major}`);

      // each line: "gpiochip0 [pinctrl-bcm2711] (58 lines)"
      const chips = await this.gpiodRun("gpiodetect", []);
      chips.split("\n").forEach((chip) => log(`[GPIOD] Check chip: ${chip}`));
      const found = chips.split("\n").find((chip) => chip.includes("[pinctrl-"));
      if (!found) throw new Error("No Chip Found!");
      this.pirChip = found.split(" ")[0];
      console.log(`[MMM-Pir] [LIB] [PIR] [GPIOD] Found chip: ${found}`);

      // print "1" on each rising edge
      const args = major === 1
        ? ["--line-buffered", "--rising-edge", "--format=%e", this.pirChip, String(this.config.gpio)]
        : ["--edges=rising", "--format=%e", "--chip", this.pirChip, String(this.config.gpio)];
      log(`[GPIOD] Run: gpiomon ${args.join(" ")}`);
      this.pir = spawn("gpiomon", args);
    } catch (err) {
      console.error(`[MMM-Pir] [LIB] [PIR] [GPIOD] ${err.message}`);
      this.running = false;
      return this.callback("PIR_ERROR", err.message);
    }

    let stderr = "";
    this.pir.stderr.on("data", (data) => { stderr += data; });
    this.pir.stdout.on("data", (data) => {
      data.toString().split("\n").forEach((line) => {
        if (line.trim() !== "1") return;
        log("Detected presence");
        this.callback("PIR_DETECTED");
      });
    });
    this.pir.on("error", (err) => {
      console.error(`[MMM-Pir] [LIB] [PIR] [GPIOD] ${err.message}`);
      this.running = false;
      this.callback("PIR_ERROR", err.message);
    });
    this.pir.on("exit", (code, signal) => {
      if (!this.running) return;
      const message = stderr.trim() || `gpiomon exited (code: ${code}, signal: ${signal})`;
      console.error(`[MMM-Pir] [LIB] [PIR] [GPIOD] ${message}`);
      this.running = false;
      this.pir = null;
      this.callback("PIR_ERROR", message);
    });
    process.once("exit", () => this.pir?.kill());

    this.running = true;
    this.callback("PIR_STARTED");
    console.log("[MMM-Pir] [LIB] [PIR] Started!");
  }

  gpiodRun (command, args) {
    return new Promise((resolve, reject) => {
      execFile(command, args, (err, stdout, stderr) => {
        if (err) reject(new Error(err.code === "ENOENT" ? `${command} not found, please install the gpiod package` : (stderr.trim() || err.message)));
        else resolve(stdout.trim());
      });
    });
  }
}

module.exports = PIR;
