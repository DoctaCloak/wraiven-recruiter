import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';

export default {
    data: new SlashCommandBuilder()
        .setName('view-applicants')
        .setDescription('Shows all applicants for a specific guild opening. (Officer only)')
        .addStringOption(option =>
            option.setName('opening_id')
                .setDescription('The ID of the guild opening to view applicants for.')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('status_filter')
                .setDescription('Filter applicants by status.')
                .setRequired(false)
                .addChoices(
                    { name: 'New Application', value: 'new' },
                    { name: 'Under Review', value: 'review' },
                    { name: 'Scheduled for Chat/Trial', value: 'trial_scheduled' },
                    { name: 'Currently Trialing', value: 'trialing' },
                    { name: 'Accepted', value: 'accepted' },
                    { name: 'Declined', value: 'declined' },
                    { name: 'Withdrawn', value: 'withdrawn' }
                ))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles), // Example: Officers with Manage Roles permission
    async execute(interaction) {
        const openingId = interaction.options.getString('opening_id');
        const statusFilter = interaction.options.getString('status_filter');

        // TODO: Add logic to fetch applicants from a database based on opening_id and status_filter
        // TODO: Implement proper permission checks (e.g., based on Officer Role from setup)

        let content = `Viewing applicants for guild opening ID: ${openingId} (simulated).`;
        if (statusFilter) content += `\nFiltering by status: ${statusFilter}`;
        // Actual applicant listing would go here

        await interaction.reply({ content: content, ephemeral: true });
    },
}; 