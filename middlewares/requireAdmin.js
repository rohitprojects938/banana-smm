const requireAdmin = (req, res, next) => {
  if (req.session.userId && req.session.isAdmin === 1) {
    return next();
  }
  return res.redirect('/dashboard');
};

module.exports = requireAdmin;
