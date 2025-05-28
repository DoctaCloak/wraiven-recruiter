/*************************
 *     IMPORTS & CONFIG
 *************************/
import fs from "fs";
import path from "path";
import "dotenv/config";
import express from "express";
import { config } from "dotenv";
import { MongoClient, ServerApiVersion } from "mongodb";
import { Client, Collection, GatewayIntentBits } from "discord.js";

// Load environment variables
config();
const { DISCORD_TOKEN, PUBLIC_KEY, PORT = 3001 } = process.env;

if (!DISCORD_TOKEN || !PUBLIC_KEY) {
  console.error("DISCORD_TOKEN and PUBLIC_KEY are required");
  process.exit(1);
}

// Root directory
const ROOT_DIR = process.cwd();

/*************************
 *   MONGODB CONNECTION
 *************************/
const username = encodeURIComponent("doctacloak");
const password = encodeURIComponent("lY6vNE59x0irLdFH");
const uri = `mongodb+srv://${username}:${password}@housevalier.hrmke.mongodb.net/?retryWrites=true&w=majority&appName=HouseValier`;

const MONGO_CLIENT = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

let database = null;

/**
 * Connects to MongoDB and sets the global `database` variable.
 */
async function connectDatabase() {
  await MONGO_CLIENT.connect();
  database = MONGO_CLIENT.db("HouseValier");
  // Ping for sanity check
  await database.command({ ping: 1 });
  console.log("Successfully connected to MongoDB!");
}

/*************************
 *   DISCORD CLIENT SETUP
 *************************/
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// Prepare commands collection
client.commands = new Collection();

/*************************
 *   EXPRESS SERVER SETUP
 *************************/
const app = express();
app.use(express.json());
app.listen(PORT, () => {
  console.log("Express server is listening on port", PORT);
});

/*************************
 *  BOOTSTRAP FUNCTION
 *************************/
async function main() {
  // 1) Wait for the DB to connect
  await connectDatabase();

  // 2) Load commands
  await loadCommands();

  // 3) Load events (now we pass in the guaranteed `database`)
  await loadEvents(database);

  // 4) Finally log in to Discord (this makes the bot go online)
  await client.login(DISCORD_TOKEN);
  console.log("Bot logged in!");
}

/*************************
 *     LOAD COMMANDS
 *************************/
async function loadCommands() {
  const COMMANDS_FOLDER = path.join(ROOT_DIR, "app/commands");
  const commandFolders = fs.readdirSync(COMMANDS_FOLDER);

  for (const commandSubfolder of commandFolders) {
    const commandsPath = path.join(COMMANDS_FOLDER, commandSubfolder);
    const commandFiles = fs
      .readdirSync(commandsPath)
      .filter((file) => file.endsWith(".js"));

    for (const file of commandFiles) {
      const filePath = path.join(commandsPath, file);
      const { default: command } = await import(`file://${filePath}`);
      if (command?.data && command?.execute) {
        client.commands.set(command.data.name, command);
      } else {
        console.warn(
          `[WARNING] The command at ${filePath} is missing "data" or "execute".`
        );
      }
    }
  }
}

/*************************
 *     LOAD EVENTS
 *************************/
async function loadEvents(db) {
  const EVENTS_FOLDER = path.join(ROOT_DIR, "app", "events");
  const eventFiles = fs
    .readdirSync(EVENTS_FOLDER)
    .filter((file) => file.endsWith(".js"));

  for (const file of eventFiles) {
    const filePath = path.join(EVENTS_FOLDER, file);
    const eventModule = await import(`file://${filePath}`);

    // Each event file default-exports a function that takes (client, database)
    if (typeof eventModule.default === "function") {
      eventModule.default(client, db);
    } else {
      console.error(`Event file ${file} is missing a default export function.`);
    }
  }
}

// Execute our main function
main().catch((err) => console.error("Error in main()", err));
