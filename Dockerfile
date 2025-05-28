# Use an official Node.js runtime as a parent image
FROM node:18-alpine

# Set the working directory in the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json (or yarn.lock)
COPY package*.json ./

# Install project dependencies
# If you use yarn, replace the next line with 'RUN yarn install --frozen-lockfile'
RUN npm ci

# Copy the rest of the application code
COPY . .

# Install slash commands
RUN npm run register

# Application port (if any)
# EXPOSE 3000

# Define environment variables (if any)
# ENV VAR_NAME=value

# Command to run the application
# Replace main.js with your actual main script file, or use 'npm start'
CMD [ "node", "app.js" ] 