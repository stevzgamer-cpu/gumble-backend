const jwt = require('jsonwebtoken');

// Middleware to protect the /bet route
const verifyToken = (req, res, next) => {
  const token = req.header('Authorization');
  if (!token) return res.status(401).send('Access Denied');
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (err) { res.status(400).send('Invalid Token'); }
};

app.post('/bet', verifyToken, async (req, res) => {
  // Only users with a valid token can reach this code
  const user = await User.findById(req.user.userId);
  // ... rest of game logic
});