# docker build -t docker.homejota.net/geoos/noaa-gfs4:latest -t docker.homejota.net/geoos/noaa-gfs4:0.81 .
# docker push docker.homejota.net/geoos/noaa-gfs4:latest

FROM docker.homejota.net/geoos/node14-python3
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install --production

COPY . .
CMD ["node", "index"]