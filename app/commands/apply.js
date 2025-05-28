const { SlashCommandBuilder } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('apply')
        .setDescription('Apply for an open guild role or express interest.')
        .addStringOption(option =>
            option.setName('opening_id')
                .setDescription('The ID of the specific opening you are applying for (if known).')
                .setRequired(false)) // Making it optional if they want to generally apply
        .addStringOption(option =>
            option.setName('character_name')
                .setDescription('Your main character\'s in-game name.')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('character_class')
                .setDescription('Your character\'s class.')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('character_spec')
                .setDescription('Your character\'s primary specialization/spec.')
                .setRequired(true))
        .addIntegerOption(option =>
            option.setName('character_level')
                .setDescription('Your character\'s current level.')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('profile_link')
                .setDescription('Link to your character profile (e.g., Armory, Lodestone, Raider.IO).')
                .setRequired(false))
        .addStringOption(option =>
            option.setName('short_message')
                .setDescription('Why you want to join or are interested in this role/guild.')
                .setRequired(false)),
    async execute(interaction) {
        const options = interaction.options;
        const openingId = options.getString('opening_id');
        const charName = options.getString('character_name');
        const charClass = options.getString('character_class');
        const charSpec = options.getString('character_spec');
        // ... retrieve other options
        const userId = interaction.user.id;

        // TODO: Add logic to save application to a database
        // TODO: Potentially notify officers/log channel

        let message = `Application from ${interaction.user.tag} for character ${charName} (${charClass} - ${charSpec}) received (simulated).`;
        if (openingId) message += `\nFor opening ID: ${openingId}`;

        await interaction.reply({ content: message, ephemeral: true });
    },
}; 