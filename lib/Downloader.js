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
        let logsPath = config.dataPath + "/logs";
        if (!fs.existsSync(logsPath)) fs.mkdirSync(logsPath);
        let downloadPath = config.dataPath + "/download";
        if (!fs.existsSync(downloadPath)) fs.mkdirSync(downloadPath);
        let importPath = config.dataPath + "/import";
        if (!fs.existsSync(importPath)) fs.mkdirSync(importPath);

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
                if (f.startsWith(this.code + "-") && f.endsWith(".grb2")) {
                    fs.unlinkSync(downloadPath + "/" + f);
                }
            } catch(err) {}
        })

        this.callDaemon(2000);
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
        try {
            if (this.running) {
                log.warn("Daemon runing when called. Ignoring");
                return;
            }
            log.debug("Starting daemon");
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
                    return;
                }
                let isNewModel = !state.lastModel || mExec.time.valueOf() > state.lastModel;
                if (!isNewModel) {
                    log.debug("No new model found");
                    return;
                }
                state.currentModel = mExec.time.valueOf();
                state.files = [];
                let hh = 0;
                while (hh <= 384) {
                    let url = mExec.getNOAAUrl(hh);
                    let forecastTime = mExec.time.clone().add(hh, "hours");
                    let fileName = this.code + "-" + forecastTime.format("YYYY-MM-DD_HH-mm") + ".grb2"
                    state.files.push({url, fileName, status:"pending", retries:0});
                    hh += 3;
                }
                this.setState(state);
            }
            let t0 = Date.now();
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

    async startInitialDownloads() {
        let state = this.getState();
        if (!state.files) {
            log.error("No files in state when starting download");
            this.rejectDownload("No files in state when starting download");
            return;
        }
        let nActive = state.files.filter(f => f.status == "downloading").length;
        while (nActive < config.nParallelDownloads) {
            this.startNextDownload();
            // Sleep 10 sec
            await (new Promise(resolve => {setTimeout(_ => resolve(), 10000)}));
            state = this.getState();
            nActive = state.files?state.files.filter(f => f.status == "downloading").length:0
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
        this.setState(state);
        this.downloadFile(file)
            .then(_ => {
                state = this.getState();
                let f2 = state.files.find(f => f.url == file.url);
                f2.status = "ok";
                this.setState(state);
                this.startNextDownload();
            })
            .catch(error => {
                state = this.getState();
                let f2 = state.files.find(f => f.url == file.url);
                f2.retries++;
                if (f2.retries > config.nRetries) {
                    log.error("Error downloading file '" + f2.url + "': " + error.toString() + ". Max retries (" + config.nRetries + ") reached. File discarted");
                    f2.status = "error";
                } else {
                    log.warn("Error downloading file '" + f2.url + "': " + error.toString() + ". Retry " + f2.retries + "/" + config.nRetries);
                    f2.status = "pending";
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
            https.get(file.url, response => {
                if (response && response.statusCode == 200) {
                    try {
                        response.pipe(fileStream);
                    } catch(error) {
                        console.error(error);
                        log.error("Error preparing download:" + error.toString());
                        reject(error);
                    }
                    fileStream.on('finish', _ => {
                        fileStream.close(_ => {
                            log.debug("File " + file.url + " downloaded in " + parseInt((Date.now() - t0) / 1000) + " seconds");
                            try {
                                fs.renameSync(dstFile, config.dataPath + "/import/" + file.fileName)
                            } catch(error) {
                                log.error(`Error moving file ${dstFile} to ${config.dataPath + "/import/" + file.fileName}: ${error.toString()}`);
                                reject(error);
                                return;
                            }
                            resolve();
                        });
                    });
                    fileStream.on('error', err => {
                        console.log("ReceiveFileStream Error", err);
                        try {
                            try {
                                fs.unlinkSync(dstFile);
                            } catch(error) {}
                            log.error(`Error downloading file ${file.url}: ${error.toString()}`)
                        } catch(err2) {}
                        reject(err);
                    });
                } else {
                    reject("Response Status Code:" + response.statusCode);
                }
            });
        });
    }
}

module.exports = Downloader.instance;