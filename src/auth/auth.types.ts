import {
  IsEmail,
  IsString,
  IsOptional,
  MinLength,
  MaxLength,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RequestOtpDto {
  @ApiProperty({ example: 'you@example.com' })
  @IsEmail()
  email!: string;
}

export class VerifyOtpDto {
  @ApiProperty({ example: 'you@example.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ minLength: 6, maxLength: 6, example: '123456' })
  @IsString()
  @MinLength(6)
  @MaxLength(6)
  code!: string;

  @ApiProperty({
    required: false,
    maxLength: 20,
    description: 'Required to create a new account; omit on login for an existing one.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  displayName?: string;
}

export class UpdateProfileDto {
  @ApiProperty({ minLength: 1, maxLength: 20 })
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  displayName!: string;
}

/**
 * The public shape of a `Player` row. Prisma's generated `Player` type has
 * no runtime metadata for Swagger to introspect, so this is a hand-mirrored
 * response DTO — keep it in sync with `prisma/schema.prisma`'s `Player`
 * model if that ever changes.
 */
export class PlayerDto {
  @ApiProperty() id!: string;
  @ApiProperty({ nullable: true, type: String }) email!: string | null;
  @ApiProperty() displayName!: string;
  @ApiProperty({ nullable: true, type: String }) avatarUrl!: string | null;
  @ApiProperty() level!: number;
  @ApiProperty() xp!: number;
  @ApiProperty() trophies!: number;
  @ApiProperty() totalGames!: number;
  @ApiProperty() totalWins!: number;
  @ApiProperty() winStreak!: number;
  @ApiProperty() bestStreak!: number;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
  @ApiProperty() isBot!: boolean;
}

export class AuthResponseDto {
  @ApiProperty({ description: 'Bearer JWT, 30 day expiry.' }) token!: string;
  @ApiProperty({ type: PlayerDto }) player!: PlayerDto;
}
