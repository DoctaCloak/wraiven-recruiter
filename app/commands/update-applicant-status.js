const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('update-applicant-status')
        .setDescription('Updates an applicant\'s status for a guild role. (Officer only)')
        .addStringOption(option =>
            option.setName('application_id')
                .setDescription('The ID of the guild application to update.')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('new_status')
                .setDescription('The new status for the applicant.')
                .setRequired(true)
                .addChoices(
                    { name: 'New Application', value: 'new' },
                    { name: 'Under Review', value: 'review' },
                    { name: 'Contacted - Awaiting Reply', value: 'contacted' },
                    { name: 'Scheduled for Chat/Trial', value: 'trial_scheduled' },
                    { name: 'Currently Trialing', value: 'trialing' },
                    { name: 'Accepted - Initiate', value: 'accepted_initiate' },
                    { name: 'Accepted - Member', value: 'accepted_member' }, // Or whatever your ranks are
                    { name: 'Declined - Fit', value: 'declined_fit' },
                    { name: 'Declined - Experience', value: 'declined_experience' },
                    { name: 'Declined - No Show/Inactive', value: 'declined_inactive' },
                    { name: 'Withdrawn by Applicant', value: 'withdrawn' }
                ))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles), // Example permission
    async execute(interaction) {
        const applicationId = interaction.options.getString('application_id');
        const newStatus = interaction.options.getString('new_status');

        // TODO: Add logic to update applicant status in the database for guild application
        // TODO: Implement proper permission checks

        await interaction.reply({ 
            content: `Simulated update for guild application ID ${applicationId}: Set status to '${newStatus}'.`,
            ephemeral: true 
        });
    },
}; 