import { SlashCommandBuilder, PermissionFlagsBits, ChannelType } from 'discord.js';

export default {
    data: new SlashCommandBuilder()
        .setName('setup-guild-recruitment')
        .setDescription('Configures guild recruitment channels and roles. (Admin/Lead Officer only)')
        .addChannelOption(option =>
            option.setName('openings_channel')
                .setDescription('Channel where new guild openings are posted publicly.')
                .addChannelTypes(ChannelType.GuildText)
                .setRequired(true))
        .addChannelOption(option =>
            option.setName('applications_channel')
                .setDescription('Private channel for officers to see new applications & discuss.')
                .addChannelTypes(ChannelType.GuildText)
                .setRequired(true))
        .addRoleOption(option =>
            option.setName('officer_role')
                .setDescription('Role that grants guild recruitment management permissions.')
                .setRequired(true))
        .addChannelOption(option =>
            option.setName('welcome_message_channel')
                .setDescription('Channel to send a welcome message to new server members (optional).')
                .addChannelTypes(ChannelType.GuildText)
                .setRequired(false))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator), // Restricted to server administrators
    async execute(interaction) {
        const openingsChannel = interaction.options.getChannel('openings_channel');
        const applicationsChannel = interaction.options.getChannel('applications_channel');
        const officerRole = interaction.options.getRole('officer_role');
        const welcomeChannel = interaction.options.getChannel('welcome_message_channel');

        // TODO: Add logic to save these settings to a server-specific configuration in the database

        let message = `Guild recruitment setup (simulated):\n**Openings Public Channel:** ${openingsChannel.name}\n**Applications Log Channel (Private):** ${applicationsChannel.name}\n**Officer Role:** ${officerRole.name}`;
        if (welcomeChannel) message += `\n**Welcome Message Channel:** ${welcomeChannel.name}`;

        await interaction.reply({ content: message, ephemeral: true });
    },
}; 