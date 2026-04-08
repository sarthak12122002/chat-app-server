import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { db } from '../config/database.js';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

export class AuthController {
  static async register(req, res, next) {
    try {
      const { email, password, name } = req.validatedData;

      logger.info('User details', req.validatedData);

      // Check if user exists
      const existingUser = await db('users').where({ email }).first();
      if (existingUser) {
        return res.status(400).json({ error: 'Email already registered' });
      }

      // Hash password
      const password_hash = await bcrypt.hash(password, 10);

      // Create user
      const [user] = await db('users')
        .insert({ email, password_hash, name })
        .returning(['id', 'email', 'name', 'created_at']);

      // Generate token
      const token = jwt.sign(
        { id: user.id, email: user.email },
        config.jwt.secret,
        { expiresIn: config.jwt.expiresIn }
      );

      logger.info('User registered', { userId: user.id, email: user.email });

      res.status(201).json({ token, user });
    } catch (error) {
      next(error);
    }
  }

  static async login(req, res, next) {
    try {
      const { email, password } = req.validatedData;

      // Find user
      const user = await db('users').where({ email }).first();
      if (!user) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      // Verify password
      const validPassword = await bcrypt.compare(password, user.password_hash);
      if (!validPassword) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      // Generate token
      const token = jwt.sign(
        { id: user.id, email: user.email },
        config.jwt.secret,
        { expiresIn: config.jwt.expiresIn }
      );

      logger.info('User logged in', { userId: user.id, email: user.email });

      res.json({
        token,
        user: {
          id: user.id,
          email: user.email,
          name: user.name
        }
      });
    } catch (error) {
      next(error);
    }
  }

  static async me(req, res, next) {
    try {
      if (!req.user) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      const user = await db('users')
        .where({ id: req.user.id })
        .select('id', 'email', 'name', 'created_at')
        .first();

      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      res.json({ user });
    } catch (error) {
      next(error);
    }
  }

  static async logout(req, res, next) {
    try {
      // Since we're using JWT, logout is handled client-side
      // But we can log the event
      if (req.user) {
        logger.info('User logged out', { userId: req.user.id });
      }

      res.json({ message: 'Logged out successfully' });
    } catch (error) {
      next(error);
    }
  }
}