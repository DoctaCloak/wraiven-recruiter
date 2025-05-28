import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';

export default {
    data: new SlashCommandBuilder()
        .setName('how-to-apply')
        .setDescription('Instructions on how to apply to our guild.'),
    async execute(interaction) {
        const embed = new EmbedBuilder()
            .setColor(0x0099FF)
            .setTitle('How to Apply to [Your Guild Name Here]')
            .setDescription('Interested in joining us? Here\'s how to apply:')
            .addFields(
                { name: '1. Check Openings', value: 'Use `/list-openings` to see our current needs. Even if your class/role isn\'t listed, exceptional players are always considered!' },
                { name: '2. Prepare Your Info', value: 'Have your main character\'s name, class, spec, level, and a link to their profile (Armory, Raider.IO, etc.) ready.' },
                { name: '3. Use the Apply Command', value: 'Submit your application using the `/apply` command. Fill out all the details as accurately as possible. If applying for a specific opening, use its ID.' },
                { name: '4. Short Message', value: 'Tell us a bit about yourself and why you\'re interested in joining our guild in the optional message field.' },
                { name: '5. What Happens Next?', value: 'An officer will review your application. We may reach out for a chat or to invite you for some trial runs. You can check your application status with `/my-applications`.' },
                { name: '\nQuestions?', value: 'Whisper an Officer in-game or message one of our recruiters on Discord if you have any questions! You can often find officer names in the #guild-info channel or `/guild-info` command.' }
            )
            .setTimestamp()
            .setFooter({ text: '[Your Guild Name Here] Recruitment' });

        await interaction.reply({ embeds: [embed], ephemeral: true });
    },
}; 