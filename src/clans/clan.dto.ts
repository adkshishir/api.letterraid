import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { CLAN_NAME_MAX_LENGTH, CLAN_NAME_MIN_LENGTH } from './clan.types.js';

export class CreateClanDto {
  @ApiProperty({
    minLength: CLAN_NAME_MIN_LENGTH,
    maxLength: CLAN_NAME_MAX_LENGTH,
    example: 'Vowel Vandals',
  })
  @IsString()
  @MinLength(CLAN_NAME_MIN_LENGTH)
  @MaxLength(CLAN_NAME_MAX_LENGTH)
  name!: string;
}
