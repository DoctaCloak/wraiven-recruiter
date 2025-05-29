import { Events, ChannelType, PermissionsBitField, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { ensureCategory, buildProcessingChannelPermissions, logBotMsgToHistory } from './onGuildMemberAdd.js'; // Re-use existing helpers
import { notifyStaff } from '../utils/discord_actions.js';

// Load configuration
const configPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

const RECRUITMENT_TICKET_CATEGORY_NAME = config.CATEGORIES.RECRUITMENT_TICKETS;
const APPLICATION_TICKET_MESSAGE = config.APPLICATION_TICKET_MESSAGE;
const RECRUITER_ROLE_NAME = config.ROLES.RECRUITER;
const BOT_ROLE_NAME = config.ROLES.BOT;

const ConversationStep = { // Ensure this matches the one in onGuildMemberAdd & onMessageCreate
    IDLE: 'IDLE',
    AWAITING_APPLICATION_TICKET_SUBMISSION: 'AWAITING_APPLICATION_TICKET_SUBMISSION' // New state
    // ... other states if needed, ensure consistency
};


export default function onInteractionCreate(client, database) {
    client.on(Events.InteractionCreate, async (interaction) => {
        if (!interaction.isButton()) return;

        const guild = interaction.guild;
        if (!guild) return;

        const recruitmentCollection = database.collection("recruitment");
        const messageHistoryCollection = database.collection("messageHistory");
        const member = interaction.member;
        const userId = member.id;

        if (interaction.customId === 'open_recruitment_ticket') {
            console.log(`[onInteractionCreate] User ${member.user.tag} clicked 'open_recruitment_ticket' button.`);

            try {
                await interaction.deferReply({ ephemeral: true }); // Acknowledge the interaction quickly

                // 1. Find or create the "Recruitment Tickets" category
                const ticketsCategory = await ensureCategory(guild, RECRUITMENT_TICKET_CATEGORY_NAME);
                if (!ticketsCategory) {
                    await interaction.editReply("Sorry, I couldn\\'t set up the ticket channel due to a category configuration issue. Please contact staff.");
                    await notifyStaff(guild, `CRITICAL: Could not find or create the category named \\"${RECRUITMENT_TICKET_CATEGORY_NAME}\\" for ${member.user.tag}. Ticket creation failed.`, "CONFIG_ERROR_TICKET_CATEGORY");
                    return;
                }

                // 2. Create the new ticket channel
                const ticketChannelName = `ticket-${member.user.username.substring(0, 25).replace(/\s+/g, '-')}`; // Ensure valid channel name
                let ticketChannel;
                try {
                    ticketChannel = await guild.channels.create({
                        name: ticketChannelName,
                        type: ChannelType.GuildText,
                        parent: ticketsCategory.id,
                        topic: `Recruitment ticket for ${member.user.tag} (ID: ${userId}). Opened at ${new Date().toISOString()}`
                    });
                    console.log(`[onInteractionCreate] Created ticket channel #${ticketChannel.name} for ${member.user.tag}.`);
                } catch (channelError) {
                    console.error(`[onInteractionCreate] Failed to create ticket channel for ${member.user.tag}:`, channelError);
                    await interaction.editReply("Sorry, I ran into an error trying to create your ticket channel. Please try again or contact staff.");
                    await notifyStaff(guild, `Error creating ticket channel for ${member.user.tag} under \\"${RECRUITMENT_TICKET_CATEGORY_NAME}\\". Error: ${channelError.message}`, "TICKET_CHANNEL_CREATION_ERROR");
                    return;
                }

                // 3. Set permissions for the new channel
                // Reuse buildProcessingChannelPermissions, but adapt if needed for tickets (e.g., different roles)
                // For now, assume the same permissions as processing channels are fine
                const ticketPermissions = buildProcessingChannelPermissions(member, guild); // This function uses RECRUITER and BOT roles from config
                await ticketChannel.permissionOverwrites.set(ticketPermissions);
                console.log(`[onInteractionCreate] Set permissions for ticket channel #${ticketChannel.name}.`);

                // 4. Post the application message in the new channel
                try {
                    const sentTicketMessage = await ticketChannel.send(APPLICATION_TICKET_MESSAGE);
                    // Optionally, log this initial message to messageHistoryCollection if desired
                    // For now, the primary interaction is the user filling out the info.
                    await logBotMsgToHistory(messageHistoryCollection, recruitmentCollection, userId, ticketChannel.id, APPLICATION_TICKET_MESSAGE, sentTicketMessage.id, null);

                } catch (msgError) {
                    console.error(`[onInteractionCreate] Failed to send application message to #${ticketChannel.name}:`, msgError);
                    await interaction.editReply("I created your ticket channel, but couldn\\'t post the instructions. Please contact staff.");
                    // Don\\'t delete the channel, staff can still use it.
                }
                
                // 5. Update user\'s record in DB
                try {
                    await recruitmentCollection.updateOne(
                        { userId: userId },
                        { 
                            $set: { 
                                ticketChannelId: ticketChannel.id,
                                applicationStatus: "TICKET_OPENED", // New status
                                "conversationState.currentStep": ConversationStep.AWAITING_APPLICATION_TICKET_SUBMISSION,
                                "conversationState.activeCollectorType": null, // No collector here, user types freely
                                "conversationState.timeoutTimestamp": null, // Or set a long timeout for ticket submission
                                "conversationState.lastLlmIntent": "APPLICATION_TICKET_OPENED",
                                lastActivityAt: new Date()
                            },
                            $push: { logs: { timestamp: new Date(), event: `Recruitment ticket opened: #${ticketChannel.name}` } }
                        },
                        { upsert: true } // Upsert in case this is a very first interaction for some reason
                    );
                    console.log(`[onInteractionCreate] Updated DB for ${member.user.tag} with new ticket channel ${ticketChannel.id}.`);
                } catch (dbError) {
                    console.error(`[onInteractionCreate] Failed to update DB for ${member.user.tag} after opening ticket:`, dbError);
                    // Non-fatal for user, but staff should be aware if logging fails
                    await notifyStaff(guild, `DB update failed for ${member.user.tag} after opening ticket ${ticketChannel.name}. Error: ${dbError.message}`, "TICKET_DB_UPDATE_ERROR");
                }

                // 6. Confirm to user
                await interaction.editReply(`Your recruitment ticket channel has been created: ${ticketChannel.toString()}. Please find the instructions there.`);

                // 7. Optionally, disable the button on the original message or update that message
                if (interaction.message) {
                    const originalButton = new ButtonBuilder()
                        .setCustomId('open_recruitment_ticket_opened')
                        .setLabel('Ticket Opened')
                        .setStyle(ButtonStyle.Success)
                        .setDisabled(true);
                    const row = new ActionRowBuilder().addComponents(originalButton);
                    try {
                        await interaction.message.edit({ components: [row] });
                    } catch (editError) {
                        console.warn(`[onInteractionCreate] Could not disable button on original message: ${editError.message}`);
                    }
                }
                 // 8. Send a message to the original processing channel if it\'s different from the ticket channel
                 // (This assumes the button was clicked in the processing channel)
                 if (interaction.channel.id !== ticketChannel.id) {
                    try {
                        await interaction.channel.send(`A recruitment ticket has been opened for you: ${ticketChannel.toString()}`);
                    } catch (e) {
                        console.warn(`[onInteractionCreate] Could not send confirmation to original processing channel: ${e.message}`);
                    }
                 }


            } catch (error) {
                console.error('[onInteractionCreate] General error handling open_recruitment_ticket:', error);
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({ content: 'An unexpected error occurred. Please try again or contact staff.', ephemeral: true }).catch(console.error);
                } else if (interaction.deferred && !interaction.replied) {
                    await interaction.editReply({ content: 'An unexpected error occurred. Please try again or contact staff.' }).catch(console.error);
                }
                await notifyStaff(guild, `General error during 'open_recruitment_ticket' for ${member.user.tag}. Error: ${error.message}`, "TICKET_GENERAL_ERROR");
            }
        }
        // Add other button handlers here if needed e.g. close_ticket_button
    });
} 