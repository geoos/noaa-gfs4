const log = require("./lib/Logs")
const downloader = require("./lib/Downloader")

downloader.init();
log.info("NOAA-GFS4 [0.99] downloader initialized");