# docker buildx build --push --platform linux/amd64,linux/arm64 -t docker.homejota.net/geoos/noaa-gfs4:latest -t docker.homejota.net/geoos/noaa-gfs4:0.96 .
#
# docker build -t docker.homejota.net/geoos/noaa-gfs4:latest -t docker.homejota.net/geoos/noaa-gfs4:0.89 .
# docker push docker.homejota.net/geoos/noaa-gfs4:latest

FROM docker.homejota.net/geoos/node14-python3
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install --production

COPY . .
CMD ["node", "index"]