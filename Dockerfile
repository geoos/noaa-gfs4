# docker build -t geoos/noaa-gfs4:latest -t geoos/noaa-gfs4:0.80 .
# docker push geoos/noaa-gfs4:latest

FROM geoos/node14-python3
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install --production

COPY . .
CMD ["node", "index"]