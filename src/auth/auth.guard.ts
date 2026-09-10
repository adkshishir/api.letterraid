import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthService } from './auth.service.js';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly authService: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers?.authorization;

    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedException(
        'Missing or invalid authorization header',
      );
    }

    const token = authHeader.slice(7);
    const player = await this.authService.validateToken(token);
    request.player = player;
    return true;
  }
}

/**
 * For routes that are public but want `req.player` when the caller happens
 * to be signed in (e.g. `GET /clans/:id`'s `myRole`) — unlike `JwtAuthGuard`,
 * a missing or invalid token never blocks the request; it just leaves
 * `req.player` unset.
 */
@Injectable()
export class OptionalJwtAuthGuard implements CanActivate {
  constructor(private readonly authService: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers?.authorization;

    if (authHeader?.startsWith('Bearer ')) {
      try {
        request.player = await this.authService.validateToken(authHeader.slice(7));
      } catch {
        // Invalid/expired token on a public route — proceed unauthenticated.
      }
    }
    return true;
  }
}
