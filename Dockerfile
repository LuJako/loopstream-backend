FROM node:20-alpine

# Install FFmpeg
RUN apk add --no-cache ffmpeg

WORKDIR /app

# Copy package files
COPY package*.json ./
RUN npm install --omit=dev

# Copy seluruh isi folder backend ke dalam docker
COPY . .

EXPOSE 3001

# Menggunakan start script dari package.json
CMD ["npm", "start"]