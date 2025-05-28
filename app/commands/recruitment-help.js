import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';

export default {
    data: new SlashCommandBuilder()
        .setName('recruitment-help')
        .setDescription('Shows help for guild recruitment commands.'),
    async execute(interaction) {
        const embed = new EmbedBuilder()
            .setColor(0x0099FF)
            .setTitle('Guild Recruitment Bot Help')
            .setDescription('Here are the available commands specific to guild recruitment:')
            .addFields(
                // Guild Opening Management (Officer)
                { name: 'Officer Commands - Openings', value: '-------------------------------' },
                { name: '/post-opening', value: 'Post a new guild role opening.' },
                { name: '/list-openings', value: 'List current guild openings. Filters: role_type, class_filter.' },
                { name: '/view-opening', value: 'View details of a specific opening. Requires opening_id.' },
                { name: '/edit-opening', value: 'Edit an existing opening. Requires opening_id, field_to_edit, new_value.' },
                { name: '/close-opening', value: 'Close an opening. Requires opening_id.' },
                { name: '/reopen-opening', value: 'Reopen a closed opening. Requires opening_id.' },
                
                // Applicant Management (Officer)
                { name: '\nOfficer Commands - Applicants', value: '-------------------------------' },
                { name: '/view-applicants', value: 'View applicants for an opening. Requires opening_id. Filter: status_filter.' },
                { name: '/update-applicant-status', value: 'Update an applicant\'s status. Requires application_id, new_status.' },
                { name: '/schedule-event', value: 'Schedule a chat/trial with an applicant. Requires application_id, event_type, date_time, officer1. Optional: officer2, details.' },
                { name: '/add-applicant-note', value: 'Add a private note to an application. Requires application_id, note_text.' },

                // General Applicant/Member Commands
                { name: '\nApplicant & Member Commands', value: '-------------------------------' },
                { name: '/apply', value: 'Apply for a guild role. Requires character_name, class, spec, level. Optional: opening_id, profile_link, short_message.' },
                { name: '/my-applications', value: 'Check the status of your guild applications.' },
                { name: '/how-to-apply', value: 'Instructions on how to apply to the guild.' },
                { name: '/recruitment-help', value: 'Shows this help message.' },
                
                // Admin Commands for Recruitment Setup
                { name: '\nRecruitment Admin Commands', value: '-------------------------------' },
                { name: '/setup-guild-recruitment', value: 'Configure recruitment channels & officer role for the recruitment bot.' },
                { name: '/guild-recruitment-stats', value: 'Show guild recruitment specific statistics.' },
                { name: '/assign-officer-role', value: 'Assign/remove officer role (for recruitment functions) from a user.' }
            )
            .setTimestamp()
            .setFooter({ text: 'Guild Recruitment Bot' });

        await interaction.reply({ embeds: [embed], ephemeral: true });
    },
}; 