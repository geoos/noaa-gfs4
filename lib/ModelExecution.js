const config = require("./Config");
const url = require("url");
const http = require("https");

class ModelExecution {
    constructor(time) {
        this.time = time;
        let hours = this.time.hours();
        if (hours % 6) {
            hours = 6 * parseInt(hours / 6);
            this.time.hours(hours);
        }
    }

    getNOAAUrl(forecastHour, extension) {  
        if (extension === undefined) extension = "";      
        let hh = "" + forecastHour;
        if (hh.length < 3) hh = "0" + hh;
        if (hh.length < 3) hh = "0" + hh;
        return config.NOAAGSF4Url + "gfs." + this.time.format("YYYYMMDD") + "/" + this.time.format("HH") + "/gfs.t" + this.time.format("HH") + "z.pgrb2.0p25.f" + hh + extension;        
    }

    isPublished() {
        return new Promise((resolve, reject) => {            
            // Search file ".inv" to forecast hour "0000"
            let testUrl = this.getNOAAUrl(0, ".idx");
            // Test file existance (model was run for hat hour)
            let parsed = url.parse(testUrl);
            let options = {
                method:"HEAD",
                host:parsed.host,
                path: parsed.pathname,
                protocol:parsed.protocol
            };
            try {
                let req = http.request(options, r => {
                    if (r.statusCode == 200) {
                        resolve(true);
                    } else if (r.statusCode == 404) {
                        resolve(false);
                    } else {
                        reject("[" + r.statusCode + "] " + r.statusMessage);
                    }
                }).on("error", err => {
                    reject(err);
                })
                req.end();
            } catch(error) {
                reject(error);
            }
        });        
    }

    dec() {
        this.time.subtract(6, "hours");
    }
}

module.exports = ModelExecution;