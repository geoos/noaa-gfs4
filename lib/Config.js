
class Config {
    static get instance() {
        if (Config.singleton) return Config.singleton;
        Config.singleton = new Config();
        return Config.singleton;
    }

    get timeZone() {return process.env.TIME_ZONE || "America/Santiago"}
    get logLevel() {return (process.env.LOG_LEVEL || "info").toLowerCase()}
    get logRetain() {return parseInt(process.env.LOG_RETAIN || "30")}
    get logPrefix() {return (process.env.LOG_PREFIX || "noaa-gfs4-")}

    get downloaderActive() {
        let act = process.env.DOWNLOADER_ACTIVE;
        if (act && act.toLowerCase() == "false") return false;
        return true;
    }

    get dataPath() {return "/home/data"}
    get configPath() {return "/home/config"}
    get logPath() {return "/home/log"}

    get NOAAGSF4Url() {
        let url = process.env.NOAA_GFS4_URL || "https://www.ftp.ncep.noaa.gov/data/nccf/com/gfs/prod/";
        if (!url.endsWith("/")) url += "/";
        return url;
    }

    get nParallelDownloads() {return parseInt(process.env.N_PARALLEL_DOWNLOADS || "5")}
    get nRetries() {return parseInt(process.env.N_RETRIES || "5")}
}

module.exports = Config.instance;