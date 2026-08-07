import axios from 'axios';

const API_URL = 'http://localhost:5000/api/v1';
const superAdminCredentials = {
  email: 'adminofleads@gmail.com',
  password: 'hile@dsbase@123'
};

async function test() {
  try {
    const loginRes = await axios.post(`${API_URL}/auth/login`, superAdminCredentials);
    const token = loginRes.data.data.accessToken;
    const headers = { Authorization: `Bearer ${token}` };

    const vertRes = await axios.post(`${API_URL}/verticals`, {
      name: `Automotive Test ${Date.now()}`,
      description: 'Auto leads vertical',
      color: '#ff4d4d',
      icon: 'Car'
    }, { headers });
    const verticalId = vertRes.data.data.id;
    console.log("Created Vertical:", verticalId);

    const inviteRes = await axios.post(`${API_URL}/users/invite`, {
      name: 'John Admin',
      email: `admin_${Date.now()}@gmail.com`,
      roleName: 'vertical_admin',
      verticalAccess: [verticalId]
    }, { headers });
    console.log("Invite Success:", inviteRes.data);
  } catch (err) {
    if (err.response) {
      console.error("Status:", err.response.status);
      console.error("Data:", JSON.stringify(err.response.data, null, 2));
    } else {
      console.error("Error:", err.message);
    }
  }
  process.exit(0);
}

test();
