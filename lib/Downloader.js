const config = require("./Config");
const fs = require("fs");
const log = require("./Logs");
const ModelExecution = require("./ModelExecution");
const moment = require("moment-timezone");
const https = require("https");

class Downloader {
    static get instance() {
        if (Downloader.singleton) return Downloader.singleton;
        Downloader.singleton = new Downloader();
        return Downloader.singleton;
    }

    constructor() {
        this.code = "noaa-gfs4";
    }

    getState() {        
        try {
            let j = fs.readFileSync(config.dataPath + "/download/" + this.code + "-state.json");
            if (j) return JSON.parse(j);
            return {};
        } catch (error) {
            return {}
        }
    }
    setState(state) {
        fs.writeFileSync(config.dataPath + "/download/" + this.code + "-state.json", JSON.stringify(state));
    }
    init() {
        // Check f or download path existance
        let downloadPath = config.dataPath + "/download";
        if (!fs.existsSync(downloadPath)) fs.mkdirSync(downloadPath);
        let importPath = config.dataPath + "/import";
        if (!fs.existsSync(importPath)) fs.mkdirSync(importPath);
        let configFilePath = config.configPath + "/noaa-gfs4.hjson";
        if (!fs.existsSync(configFilePath)) {
            fs.copyFileSync("./lib/res/noaa-gfs4-sample-config.hjson", configFilePath);
        }

        // Cancel pending downloads from last run
        let state = this.getState();
        if (state.files) {
            state.files.forEach(f => {
                if (f.status == "downloading") {
                    f.status = "pending";
                }
            })
        }
        this.setState(state);
        let files = fs.readdirSync(downloadPath);
        files.forEach(f => {
            try {
                if (f.startsWith(this.code + "_") && f.endsWith(".grb2")) {
                    fs.unlinkSync(downloadPath + "/" + f);
                }
            } catch(err) {}
        })

        this.callDaemon(2000);
        setInterval(_ => {
            console.debug("Checking staus .... " + (this.running?"daemon is running":"daemon stopped"));            
            log.debug("Checking staus .... " + (this.running?"daemon is running":"daemon stopped"));
            if (this.running) this.showFilesStatus();
        }, 300000);
    }

    callDaemon(ms = 60000) {
        if (this.daemonTimer) clearTimeout(this.daemonTimer);
        this.daemonTimer = setTimeout(_ => {
            this.daemonTimer = null;
            this.daemon();
        }, ms);
    }
    async daemon() {
        if (!config.downloaderActive) {
            log.debug("Downloader deactivated");
            return;
        }
        if (this.running) {
            log.warn("Daemon runing when called. Ignoring");
            return;
        }
        try {
            log.debug("Starting daemon");
            this.running = true;
            let state = this.getState();
            let mExec;
            if (state.currentModel) {
                let modelTime = moment.tz(state.currentModel, "UTC");
                log.warn("Found interrupted download for model UTC:" + modelTime.format("YYYY-MM-DD HH:mm"));
                mExec = new ModelExecution(modelTime);
                let stillPublished = await mExec.isPublished();
                if (stillPublished) {
                    log.warn("Model is still published. Completing partial download");
                } else {
                    log.error("Model is not longer published. Discarding");
                    delete state.currentModel;
                    delete state.files;
                    this.setState(state);
                    mExec = null;
                }
            }
            if (!mExec) {
                mExec = new ModelExecution(moment.tz("UTC").startOf("hour"));
                let n = 0,published = false;
                do {
                    published = await mExec.isPublished();
                    if (!published) mExec.dec();
                    n++;
                } while(n < 50 && !published);
                if (!published) {
                    log.warn("No model found in NOAA");
                    this.callDaemon();
                    return;
                }
                let isNewModel = !state.lastModel || mExec.time.valueOf() > state.lastModel;
                if (!isNewModel) {
                    log.debug("No new model found");
                    this.callDaemon();
                    return;
                }
                state.currentModel = mExec.time.valueOf();
                state.files = [];
                let hh = 0, max = parseInt(config.maxForecastHours);
                while (hh <= max) {
                    let url = mExec.getNOAAUrl(hh);
                    let forecastTime = mExec.time.clone().add(hh, "hours");
                    let fileName = this.code + "_" + forecastTime.format("YYYY-MM-DD_HH-mm") + ".grb2"
                    state.files.push({url, fileName, status:"pending", retries:0});
                    hh += 3;
                }
                this.setState(state);
            }
            log.info("------ Starting download of model:" + mExec.time.format("YYYY-MM-DD HH:mm"));
            await this.downloadModel(mExec);
            state = this.getState();
            let res = state.files.reduce((res, f) => {
                res.nOk += (f.status == "ok"?1:0);
                res.nError += (f.status == "error"?1:0);
                return res;
            }, {nOk:0, nError:0});
            state.lastModel = state.currentModel;
            delete state.currentModel;
            delete state.files;
            this.setState(state);
            log.info("------ Model Downloaded:" + mExec.time.format("YYYY-MM-DD HH:mm"));
            log.info("------ -> Downloaded Files:" + res.nOk);
            log.info("------ -> Files with Error:" + res.nError);
        } catch(error) {
            console.error(error);
            log.error("Unexpected error in daemon:" + error.toString())
        } finally {
            log.debug("Daemon Finished");
            this.running = false;
            this.callDaemon();
        }
    }

    downloadModel(mExec) {
        return new Promise((resolve, reject) => {
            this.resolveDownload = resolve;
            this.rejectDownload = reject;
            this.startInitialDownloads()
        });
    }

    showFilesStatus() {
        let state = this.getState();
        if (!state.files) {
            log.debug("No files in state to show status");
            return;
        }
        log.debug("Checking download files status: ");
        log.debug("  => Total Files:" + state.files.length);
        log.debug("  => Pendig     :" + state.files.filter(f => f.status == "pending").length);
        log.debug("  => Ok         :" + state.files.filter(f => f.status == "ok").length);
        log.debug("  => Downloading:" + state.files.filter(f => f.status == "downloading").length);
        log.debug("  => Error      :" + state.files.filter(f => f.status == "error").length);
    }
    async startInitialDownloads() {
        let state = this.getState();
        if (!state.files) {
            log.error("No files in state when starting download");
            this.rejectDownload("No files in state when starting download");
            return;
        }        
        let nActive = state.files.filter(f => f.status == "downloading").length;
        let nPending = state.files.filter(f => f.status == "pending").length;
        if (!nPending) {
            log.warn("No nPending starting initial downloads.");
            this.resolveDownload();
            return;
        }
        while (nActive < config.nParallelDownloads && nPending) {
            this.startNextDownload();
            // Sleep 10 sec
            await (new Promise(resolve => {setTimeout(_ => resolve(), 10000)}));
            state = this.getState();
            nActive = state.files?state.files.filter(f => f.status == "downloading").length:0
            nPending = state.files.filter(f => f.status == "pending").length;
        }
    }
    startNextDownload() {
        let state = this.getState();
        if (!state.files) return;
        let file = state.files.find(f => f.status == "pending");
        if (!file) {
            // If no downloading files, finish daemon
            if (!state.files.find(f => f.status == "downloading")) {
                this.resolveDownload();
            }
            return;
        }
        file.status = "downloading";
        file.startTime = Date.now();
        this.setState(state);
        this.downloadFile(file)
            .then(_ => {
                state = this.getState();
                let f2 = state.files.find(f => f.url == file.url);
                f2.status = "ok";
                this.setState(state);
                this.startNextDownload();
            })
            .catch(async error => {
                state = this.getState();
                let f2 = state.files.find(f => f.url == file.url);
                f2.retries++;
                if (f2.retries > config.nRetries) {
                    log.error("Error downloading file '" + f2.url + "': " + error.toString() + ". Max retries (" + config.nRetries + ") reached. File discarted");
                    f2.status = "error";
                } else {
                    log.warn("Error downloading file '" + f2.url + "': " + error.toString() + ". Retry " + f2.retries + "/" + config.nRetries + ". Waiting 60 sec.");
                    await (new Promise(resolve => setTimeout(_ => resolve(), 60000)));
                    // reload state to refeclt changes in async timeout
                    state = this.getState();
                    f2 = state.files.find(f => f.url == file.url);
                    f2.retries++;
                    f2.status = "pending";
                    log.warn("Restarting downloads");
                }
                this.setState(state);
                this.startNextDownload();
            })
    }

    downloadFile(file) {
        return new Promise((resolve, reject) => {
            log.debug("Starting download of file: " + file.url);
            let dstFile = config.dataPath + "/download/" + file.fileName;
            let t0 = Date.now();
            let fileStream = fs.createWriteStream(dstFile);
            let request = https.get(file.url, response => {
                if (response && response.statusCode == 200) {
                    try {
                        response.pipe(fileStream);
                    } catch(error) {
                        console.error(error);
                        log.error("Error [1] preparing download:" + error.toString());
                        reject(error);
                    }
                    fileStream.on('finish', _ => {
                        if (response.timeoutTimer) {clearTimeout(response.timeoutTimer); response.timeoutTimer = null;}
                        fileStream.close(_ => {
                            log.debug("File " + file.url + " downloaded in " + parseInt((Date.now() - t0) / 1000) + " seconds");
                            try {
                                fs.renameSync(dstFile, config.dataPath + "/import/" + file.fileName)
                            } catch(error) {
                                log.error(`Error [2] moving file ${dstFile} to ${config.dataPath + "/import/" + file.fileName}: ${error.toString()}`);
                                reject(error);
                                return;
                            }
                            resolve();
                        });
                    });
                    fileStream.on('error', err => {
                        if (response.timeoutTimer) {clearTimeout(response.timeoutTimer); response.timeoutTimer = null;}
                        response.resume();
                        console.log("ReceiveFileStream Error", err);
                        try {
                            try {
                                fs.unlinkSync(dstFile);
                            } catch(error) {}
                            log.error(`Error [3] downloading file ${file.url}: ${error.toString()}`)
                        } catch(err2) {}
                        reject(err);
                    });
                    response.on("error", err => {          
                        if (response.timeoutTimer) {clearTimeout(response.timeoutTimer); response.timeoutTimer = null;}                                      
                        response.resume();
                        log.error(`Error [4] downloading file ${file.url}: ${err.toString()}`)
                        reject(err);
                    });
                    response.timeoutTimer = setTimeout(_ => {
                        log.error("Timeout (15mn) for file download. Destroying request");
                        log.error("  => File: " + file.url);
                        request.destroy(Error("Timeout descargando archivo"));
                        reject("Timeout 15m");
                    }, 15 * 60 * 1000);
                } else {
                    reject("Response [5] Status Code:" + response.statusCode);
                }
            }).on("error", err => {
                console.error("Error [7] downloading file:" + err.toString())
                log.error("Error downloading file:" + err.toString());
                reject(err);
            })            
        });
    }
}

module.exports = Downloader.instance;