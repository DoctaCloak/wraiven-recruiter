import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';

export default {
    data: new SlashCommandBuilder()
        .setName('schedule-event')
        .setDescription('Schedules a chat or trial event with an applicant. (Officer only)')
        .addStringOption(option =>
            option.setName('application_id')
                .setDescription('The ID of the guild application.')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('event_type')
                .setDescription('The type of event to schedule.')
                .setRequired(true)
                .addChoices(
                    { name: 'Informal Chat', value: 'chat' },
                    { name: 'Voice Interview', value: 'voice_interview' },
                    { name: 'Trial Raid/Dungeon', value: 'trial_run' },
                    { name: 'Gameplay Review', value: 'gameplay_review' },
                    { name: 'Other Guild Event', value: 'other_event' }
                ))
        .addStringOption(option =>
            option.setName('date_time')
                .setDescription('Date and time for the event (e.g., YYYY-MM-DD HH:MM AM/PM TZ).')
                .setRequired(true))
        .addUserOption(option =>
            option.setName('officer1')
                .setDescription('Primary officer/member involved.')
                .setRequired(true))
        .addUserOption(option =>
            option.setName('officer2')
                .setDescription('Additional officer/member involved (optional).')
                .setRequired(false))
        .addStringOption(option =>
            option.setName('details')
                .setDescription('Any additional details or notes for the event (e.g., Discord VC name, raid group).')
                .setRequired(false))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles), // Example permission
    async execute(interaction) {
        const applicationId = interaction.options.getString('application_id');
        const eventType = interaction.options.getString('event_type');
        const dateTime = interaction.options.getString('date_time');
        const officer1 = interaction.options.getUser('officer1');
        const officer2 = interaction.options.getUser('officer2');
        const details = interaction.options.getString('details');

        // TODO: Add logic to save event details, notify applicant and officers
        // TODO: Implement proper permission checks

        let message = `Simulated guild event scheduled for application ID ${applicationId}:\n**Event Type:** ${eventType}\n**Date/Time:** ${dateTime}\n**Officer 1:** ${officer1.tag}`;
        if (officer2) message += `\n**Officer 2:** ${officer2.tag}`;
        if (details) message += `\n**Details:** ${details}`;

        await interaction.reply({ content: message, ephemeral: true });
    },
};