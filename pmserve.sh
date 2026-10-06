sudo pm2 stop coesite5;
sudo pm2 delete coesite5;
sudo pm2 start app.js --name coesite5;
sudo pm2 monit;