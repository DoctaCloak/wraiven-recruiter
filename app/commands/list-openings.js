import { SlashCommandBuilder } from 'discord.js';

export default {
    data: new SlashCommandBuilder()
        .setName('list-openings')
        .setDescription('Lists current guild role openings.')
        .addStringOption(option =>
            option.setName('role_type')
                .setDescription('Filter by role type (e.g., Raid, PvP, Crafting).')
                .setRequired(false)
                .addChoices(
                    { name: 'Raid Team', value: 'raid' },
                    { name: 'PvP Team', value: 'pvp' },
                    { name: 'Crafting Specialist', value: 'crafting' },
                    { name: 'Officer Position', value: 'officer' },
                    { name: 'Social Member', value: 'social' }
                ))
        .addStringOption(option =>
            option.setName('class_filter')
                .setDescription('Filter by class (e.g., Warrior, Paladin, Mage).')
                .setRequired(false)),
    async execute(interaction) {
        const roleType = interaction.options.getString('role_type');
        const classFilter = interaction.options.getString('class_filter');

        // TODO: Add logic to fetch guild openings from a database based on filters
        
        let content = 'Listing guild openings (simulated):';
        if (roleType) content += `\n**Role Type:** ${roleType}`;
        if (classFilter) content += `\n**Class:** ${classFilter}`;
        if (!roleType && !classFilter) content += '\nNo filters applied, showing all openings.';
        // Actual opening listing would go here

        await interaction.reply({ content: content, ephemeral: true });
    },
}; 