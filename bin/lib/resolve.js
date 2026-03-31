module.exports = (pkg) => {
  try {
    return require(`dynamo-bao/${pkg}`);
  } catch {
    return require(`../../${pkg}`);
  }
};
