function makeBase64AtLength(targetLength) {
  if (targetLength % 4 !== 0) {
    throw new Error('targetLength must be divisible by 4 for valid base64');
  }

  let rawBytes = Math.ceil((targetLength / 4) * 3);
  let encoded = Buffer.alloc(rawBytes, 1).toString('base64');

  while (encoded.length < targetLength) {
    rawBytes += 3;
    encoded = Buffer.alloc(rawBytes, 1).toString('base64');
  }

  return encoded.slice(0, targetLength);
}

module.exports = {
  makeBase64AtLength
};
