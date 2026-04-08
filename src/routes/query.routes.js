import express from 'express';
import { QueryController } from '../controllers/query.controller.js';
import { validate, validateQuery } from '../middleware/validate.middleware.js';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { updateQuerySchema, queryListSchema } from '../utils/validators.js';

const router = express.Router();

// Optional auth
router.use(authMiddleware(false));

router.get('/', validateQuery(queryListSchema), QueryController.list);
router.get('/:id', QueryController.getById);
router.post('/', QueryController.create);
router.patch('/:id', validate(updateQuerySchema), QueryController.update);
router.delete('/:id', QueryController.delete);

export default router;