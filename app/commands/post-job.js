const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('post-opening')
        .setDescription('Posts a new guild role opening.')
        .addStringOption(option =>
            option.setName('role_name')
                .setDescription('The name of the role/position (e.g., Raid Healer - Priest).')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('description')
                .setDescription('Detailed description of the role and expectations.')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('class_needed')
                .setDescription('Primary class needed (e.g., Warrior, Mage, Priest).')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('spec_preferred')
                .setDescription('Preferred specialization (e.g., Protection, Frost, Discipline).')
                .setRequired(false))
        .addIntegerOption(option =>
            option.setName('level_min')
                .setDescription('Minimum character level required.')
                .setRequired(false))
        .addIntegerOption(option =>
            option.setName('item_level_min')
                .setDescription('Minimum item level or gear score required.')
                .setRequired(false))
        .addStringOption(option =>
            option.setName('experience_required')
                .setDescription('Required experience (e.g., Cleared X raid, specific PvP rating).')
                .setRequired(false))
        .addStringOption(option =>
            option.setName('availability_needed')
                .setDescription('Availability needed (e.g., Tues/Thurs 8-11 PM EST).')
                .setRequired(false))
        .addUserOption(option =>
            option.setName('contact_person')
                .setDescription('Officer to contact for this opening.')
                .setRequired(false))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles), // Example: Officers with Manage Roles permission
    async execute(interaction) {
        const options = interaction.options;
        const roleName = options.getString('role_name');
        const description = options.getString('description');
        const classNeeded = options.getString('class_needed');
        // ... (retrieve all other options similarly)

        // TODO: Save guild opening to database
        
        await interaction.reply({ 
            content: `Guild opening for **${roleName}** created (simulated).\nClass: ${classNeeded}\nDescription: ${description}`, 
            ephemeral: true 
        });
    },
}; 