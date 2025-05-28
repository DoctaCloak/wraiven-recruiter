/**
 * Returns an embed object describing the account-age restriction.
 * Adjust color, thumbnail, image, fields, etc. to match your style.
 */
export const getAccountRestrictionEmbed = (user) => {
  return {
    title: "Account Age Restriction",
    description: `Hello ${user.username}, your account is younger than 14 days. Unfortunately, you have been kicked from the server.`,
    color: 0xff3300, // Some "warning" color
    // Optionally add a thumbnail or image
    // thumbnail: { url: "https://some-image-url.png" },
    image: {
      url: "https://some-image-url.png",
    },
    footer: {
      text: "Please try again when your account is older!",
    },
  };
};
