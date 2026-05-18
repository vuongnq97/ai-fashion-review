require('dotenv').config();
const express = require('express');
const fs = require('fs');
const cors = require('cors');
const morgan = require('morgan');
const apiRoutes = require('./routes/index');

const app = express();
const port = 3000;

app.use(cors());
app.use(morgan('dev'));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Ensure uploads dir exists
if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads');
}

app.use('/api', apiRoutes);

app.listen(port, () => {
  console.log(`🚀 Playwright Automation Server listening on port ${port}`);
});
