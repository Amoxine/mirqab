import { Module } from '@nestjs/common';
import { ProductController } from './controllers/product.controller';
import { ProductService } from './services/product.service';

@Module({
  controllers: [ProductController],
  providers: [ProductService],
  exports: [ProductService],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- Nest module: the class is only a metadata carrier
export class ProductsModule {}
