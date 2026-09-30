const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const {
    findUserByEmail,
    findUserById,
    findUserByPhone,
    createUser
} = require('../models/userModel');

const { normalizeNigerianPhone } = require('../utils/phone');

const EMAIL_EXISTS = 'An account with this email already exists.';
const PHONE_EXISTS = 'This phone number is already registered.';
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(email) {
  return email.trim().toLowerCase();
}

function createToken(user) {
  return jwt.sign(
    {
      userId: user.id,
      role: user.role
    },
    process.env.JWT_SECRET,
    {
      expiresIn: '7d'
    }
  );
}

function publicUser(user) {
  return {
    id: user.id,
    name: `${user.first_name} ${user.last_name}`.trim(),
    firstName: user.first_name,
    lastName: user.last_name,
    email: user.email,
    phone: user.phone,
    role: user.role,
    isActive: user.is_active,
    createdAt: user.created_at,
    updatedAt: user.updated_at
  };
}

async function register(req, res) {
  try {
    const { email, password, phone } = req.body || {};
    let { firstName, lastName, name } = req.body || {};

    // The current frontend sends a single "name"; split it into first/last.
    if ((!firstName || !lastName) && typeof name === 'string') {
      const parts = name.trim().split(/\s+/).filter(Boolean);
      firstName = parts[0];
      lastName = parts.slice(1).join(' ');
    }

    if (
      typeof firstName !== 'string' || firstName.trim().length < 2 ||
      typeof lastName !== 'string' || lastName.trim().length < 2
    ) {
      return res.status(400).json({
        success: false,
        message: 'Please enter your first and last name.'
      });
    }

    if (typeof email !== 'string' || !EMAIL_PATTERN.test(email.trim()) || email.length > 255) {
      return res.status(400).json({
        success: false,
        message: 'Please provide a valid email address.'
      });
    }

    if (typeof password !== 'string' || password.length < 8 || password.length > 72) {
      return res.status(400).json({
        success: false,
        message: 'Password must be between 8 and 72 characters long.'
      });
    }

    const phoneNormalized = normalizeNigerianPhone(phone);

    if (!phoneNormalized) {
      return res.status(400).json({
        success: false,
        message: 'Please enter a valid Nigerian phone number, e.g. 08012345678.'
      });
    }

    const normalizedEmail = normalizeEmail(email);

    if (await findUserByEmail(normalizedEmail)) {
      return res.status(409).json({ success: false, message: EMAIL_EXISTS });
    }

    if (await findUserByPhone(phoneNormalized)) {
      return res.status(409).json({ success: false, message: PHONE_EXISTS });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const user = await createUser({
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      email: normalizedEmail,
      passwordHash,
      phone: phone.trim(),
      phoneNormalized
    });

    const token = createToken(user);

    return res.status(201).json({
      success: true,
      message: 'Account created successfully',
      token,
      user: publicUser(user)
    });
  } catch (error) {
    // Two people registering at the same instant: the database constraint is the final guard.
    if (error.code === '23505') {
      const isPhone = String(error.constraint || '').includes('phone');
      return res.status(409).json({
        success: false,
        message: isPhone ? PHONE_EXISTS : EMAIL_EXISTS
      });
    }

    console.error('Registration error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to create account'
    });
  }
}

async function login(req, res) {
  try {
    const {
      email,
      password
    } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Email and password are required'
      });
    }

    const normalizedEmail = normalizeEmail(email);

    const user = await findUserByEmail(normalizedEmail);

    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password'
      });
    }

    if (!user.is_active) {
      return res.status(403).json({
        success: false,
        message: 'This account is inactive'
      });
    }

    const passwordMatches = await bcrypt.compare(
      password,
      user.password_hash
    );

    if (!passwordMatches) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password'
      });
    }

    const token = createToken(user);

    return res.status(200).json({
      success: true,
      message: 'Login successful',
      token,
      user: publicUser(user)
    });
  } catch (error) {
    console.error('Login error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to log in'
    });
  }
}
async function getMe(req, res) {
    try {
        const user = await findUserById(req.user.id);

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        return res.status(200).json({
            success: true,
            user: publicUser(user)
        });
    } catch (error) {
        console.error('Get current user error:', error);

        return res.status(500).json({
            success: false,
            message: 'Unable to retrieve account'
        });
    }
}

module.exports = {
    register,
    login,
    getMe,
    createToken,
    publicUser
};