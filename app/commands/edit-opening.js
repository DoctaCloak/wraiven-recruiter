import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';

export default {
    data: new SlashCommandBuilder()
        .setName('edit-opening')
        .setDescription('Modifies an existing guild opening. (Officer only)')
        .addStringOption(option =>
            option.setName('opening_id')
                .setDescription('The ID of the guild opening to edit.')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('field_to_edit')
                .setDescription('The field of the guild opening to edit.')
                .setRequired(true)
                .addChoices(
                    { name: 'Role Name', value: 'role_name' },
                    { name: 'Description', value: 'description' },
                    { name: 'Class Needed', value: 'class_needed' },
                    { name: 'Spec Preferred', value: 'spec_preferred' },
                    { name: 'Min Level', value: 'level_min' },
                    { name: 'Min Item Level', value: 'item_level_min' },
                    { name: 'Experience Required', value: 'experience_required' },
                    { name: 'Availability Needed', value: 'availability_needed' },
                    { name: 'Contact Person', value: 'contact_person' },
                    { name: 'Status (Open/Closed)', value: 'status' }
                ))
        .addStringOption(option =>
            option.setName('new_value')
                .setDescription('The new value for the field.')
                .setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles), // Example: Officers with Manage Roles permission
    async execute(interaction) {
        const openingId = interaction.options.getString('opening_id');
        const fieldToEdit = interaction.options.getString('field_to_edit');
        const newValue = interaction.options.getString('new_value');

        // TODO: Add logic to update the guild opening in a database
        // TODO: Implement proper permission checks

        await interaction.reply({ 
            content: `Simulated edit for guild opening ID ${openingId}: Set ${fieldToEdit} to '${newValue}'.`,
            ephemeral: true 
        });
    },
}; 