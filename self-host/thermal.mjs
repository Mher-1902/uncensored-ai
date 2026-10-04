import {readdir,readFile} from 'node:fs/promises';
export async function tooHot(){
  try{
    for(const dir of await readdir('/sys/class/hwmon')){
      const base=`/sys/class/hwmon/${dir}`;const name=(await readFile(`${base}/name`,'utf8')).trim();
      if(!/coretemp|acpitz/.test(name))continue;
      for(const file of await readdir(base))if(/^temp\d+_input$/.test(file)&&Number(await readFile(`${base}/${file}`,'utf8'))>=85000)return true;
    }
  }catch{}
  return false;
}
