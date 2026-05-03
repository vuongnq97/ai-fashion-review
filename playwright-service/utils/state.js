let isProcessing = false;

module.exports = {
  getIsProcessing: () => isProcessing,
  setIsProcessing: (val) => { isProcessing = val; }
};
