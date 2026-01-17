const axios = require('axios');
require('dotenv').config();

const validateUser = async (token) => {
    try {
        const response = await axios.get(process.env.EXTERNAL_AUTH_API, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });


        if (response.data && response.data.success) {
            return response.data.data;
        } else {
            return null;
        }
    } catch (error) {
        console.error("Auth API Error:", error.message);
        return null;
    }
};

module.exports = { validateUser };