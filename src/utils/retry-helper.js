const retryOperation = async (operation, maxRetries = 3) => {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt === maxRetries - 1) throw error;
      
      // Check if it's a network-related error
      if (error.name === 'TimeoutError' || 
          error.code === 'NetworkingError' ||
          error.message.includes('getaddrinfo ENOTFOUND')) {
        const delay = Math.pow(2, attempt) * 100; // exponential backoff
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      
      throw error; // rethrow non-network errors immediately
    }
  }
};

module.exports = { retryOperation }; 