When using DynamoBao many common changes to models can be made without having to run a migration or deploy any changes. This is enabled through single table design, which stores all objects in a single DynamoDB table.

## Adding Models and Fields

### Adding a Model

To add a model, you can simply add a new model definition to the `models` section of your configuration file and run `npx bao-codegen` will automatically generate the corresponding model classes. (Or if you're using the `npx bao-watch`, it will automatically generate the corresponding model classes when you save the file.)

That's it! Just import the new model and start using it. No need to run a migration or deploy any changes.

### Adding a Field

To add a field to a model, you can simply add a new field definition to the `fields` section of the model definition.

## Changing Models and Fields

### Changing a Model

Models can be changed in a few ways:

1. Changing the model name
2. Changing the table type
3. Changing the fields as described below

Models _cannot_ be changed in the following ways:

1. Changing the model prefix
2. Changing the primary key
3. Changing the index id (e.g. gsi1, gsi2, etc) (\* see Modifying Indexes below)

If you need to change the model prefix or primary key, you are usually better off creating a new model with the desired configuration and copying the data from the old model to the new model.

### Removing a Field

To remove a field from a model, you can simply remove the field definition from the `fields` section of the model definition.

However, in practice, it's best not to remove field unless you are certain that all the data in that field has been removed. Removing a field will not delete the underlying data in the field, so if that field name were to be reused, it could cause unexpected behavior.

### Changing a Field

When changing a field, think carefully about what you are changing. In most cases, it is better to add a new field and copy the data from the old field to the new field. This ensures you are able to continue to access the old data while you make the change, and that any constraints related to the new field are enforced.

For instance, if you make a field required, and there are already stored objects that do not have that field, you will not be able to count on the field being present.

### Removing a Model

If you no longer need a model, and you have deleted all the data for that model, you can simply remove the model definition from the `models` section of your configuration file.

Deleting all the data for a model can be a little tricky depending on your indexes for that model. Using single table design, there is no built-in way to scan/delete all the data for a given model.

The options you have include:

1. Determining the access pattern for the data you need to delete, and writing a script that follows that pattern and deletes the data.
2. If you set up the model using the `modelPrefix` as a `partitionKey`, you can query that index to find all objects for that model and delete the data. This works for small models, is sometimes ok for medium sized models, and is not recommended for large models. It's also something you need to do when you create the model, so it won't help if you've already created the model and want to delete the data.
3. You can do a full table scan and delete the data. This isn't supported natively by DynamoBao, but it is possible through the DynamoDB API. However, this is not recommended if you are deleting a small percentage of the overall data, as it will read all the data, not just the data associated with the model.
4. Choose not to delete the data. This is the easiest option, but it will leave orphaned data in the table, and you will continue to pay for storage.

In most cases, option 1 is the best choice, but does require understanding how the data is accessed to ensure that all the data is deleted.

## Modifying Indexes

Making changes to indexes is similar to making changes to fields. In most cases, it is better to add a new index and copy the data from the old index to the new index. This ensures you are able to continue to access the old data while you make the change, and that any constraints related to the new index are enforced.

If you delete all the data for a particular index, you can reuse that index id (e.g. gsi1, gsi2, etc). However, you should be very careful about this, as if there is any old data in the index, it will be included in the new index and lead to unexpected behavior. At the very least, you should confirm that there is no old data in the index before reusing the index id.
