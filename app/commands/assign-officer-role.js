import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';

export default {
    data: new SlashCommandBuilder()
        .setName('assign-officer-role')
        .setDescription('Assigns or removes guild officer permissions to a user. (Admin only)')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('The user to modify.')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('action')
                .setDescription('Whether to assign or remove the officer role.')
                .setRequired(true)
                .addChoices(
                    { name: 'Assign Officer', value: 'assign' },
                    { name: 'Remove Officer', value: 'remove' }
                ))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator), // Only server administrators
    async execute(interaction) {
        const targetUser = interaction.options.getUser('user');
        const action = interaction.options.getString('action');
        
        // TODO: Fetch the officer role ID from server configuration (set by /setup-guild-recruitment)
        const officerRoleId = 'YOUR_OFFICER_ROLE_ID_FROM_SETUP'; // Placeholder
        
        if (!officerRoleId || officerRoleId === 'YOUR_OFFICER_ROLE_ID_FROM_SETUP') {
            return interaction.reply({ content: 'Officer role not configured. Please use /setup-guild-recruitment first.', ephemeral: true });
        }

        const member = interaction.guild.members.cache.get(targetUser.id);
        if (!member) {
            return interaction.reply({ content: 'Could not find that member in the server.', ephemeral: true });
        }

        let replyMessage = '';

        try {
            if (action === 'assign') {
                await member.roles.add(officerRoleId);
                replyMessage = `Successfully assigned guild officer role to ${targetUser.tag}. (Simulated)`;
            } else if (action === 'remove') {
                await member.roles.remove(officerRoleId);
                replyMessage = `Successfully removed guild officer role from ${targetUser.tag}. (Simulated)`;
            }
            await interaction.reply({ content: replyMessage, ephemeral: true });
        } catch (error) {
            console.error('Error modifying officer roles:', error);
            await interaction.reply({ content: 'An error occurred while trying to modify officer roles. Check console.', ephemeral: true });
        }
    },
}; 