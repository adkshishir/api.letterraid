import {
  IsEmail,
  IsString,
  IsOptional,
  MinLength,
  MaxLength,
} from 'class-validator';

export class RequestOtpDto {
  @IsEmail()
  email!: string;
}

export class VerifyOtpDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(6)
  @MaxLength(6)
  code!: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  displayName?: string;
}

export class UpdateProfileDto {
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  displayName!: string;
}
